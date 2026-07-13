import { FireState, type WorldState } from '../core/world';
import { Fuel } from '../sim/basicFuelModel';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Shared colour composition for every renderer (the on-screen canvas and the
 * headless PNG exporter) so they never drift: `cellRGB` maps one cell to RGB,
 * `renderRGBA` composes a whole frame (per-cell colours + the fire-glow
 * post-pass) into an RGBA buffer. Renderers are thin byte-copiers on top.
 *
 * Everything here is a **pure read** of world state (Phase-5 plan, decision #1).
 * Animated effects (flame flicker, water shimmer) derive from `clock.time` plus
 * an integer hash of the cell index — NEVER from `world.rng`, which would consume
 * draws the sim expects and desync the determinism golden (plan decision #2).
 */

/** Deterministic per-cell hash → [0,1). Static across frames (texture, phases). */
function hash01(i: number): number {
  let h = (i * 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = (h * 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 8) / 16777216;
}

/**
 * Lambertian hillshade from elevation central differences, NW key light.
 * Screen y grows southward, so "toward the NW light" is (-x, -y, +z). The
 * gradient is exaggerated ~2× so 30 m cells read as relief, not noise.
 */
function hillshade(world: WorldState, i: number, x: number, y: number): number {
  const { width, height, cellSize } = world;
  const e = world.layers.elevation.data;
  const xl = x > 0 ? i - 1 : i;
  const xr = x < width - 1 ? i + 1 : i;
  const yu = y > 0 ? i - width : i;
  const yd = y < height - 1 ? i + width : i;
  const scale = 2 / (2 * cellSize);
  const dzdx = (e[xr] - e[xl]) * scale;
  const dzdy = (e[yd] - e[yu]) * scale;
  // n = (-dzdx, -dzdy, 1)/|n| ; l = (-0.55, -0.55, 0.63) (unit-ish, NW, elevated)
  const inv = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
  const ndotl = (0.55 * dzdx + 0.55 * dzdy + 0.63) * inv;
  // Ambient floor + diffuse — never fully black, slopes facing NW pop.
  return 0.45 + 0.62 * (ndotl > 0 ? ndotl : 0);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Dry↔wet endpoint colours per fuel (before hillshade). Dry grass cures golden,
 * moist grass is green; timber stays darker and cooler throughout. Blending on
 * the moisture byte makes the layer that decides everything *visible* — and
 * water drops, engine knockdowns and drying wet-lines legible for free.
 */
const FUEL_DRY: Record<number, Rgb> = {
  [Fuel.Grass]: { r: 196, g: 178, b: 96 },
  [Fuel.Brush]: { r: 142, g: 132, b: 76 },
  [Fuel.Timber]: { r: 74, g: 96, b: 56 },
};
const FUEL_WET: Record<number, Rgb> = {
  [Fuel.Grass]: { r: 104, g: 158, b: 66 },
  [Fuel.Brush]: { r: 82, g: 124, b: 58 },
  [Fuel.Timber]: { r: 36, g: 80, b: 46 },
};
/** Moisture fraction at/above which a fuel reads fully lush. */
const WET_FULL = 0.35;

/** Aerial fire-retardant (Phos-Chek-style) rust-red slurry. */
const RETARDANT_RGB: Rgb = { r: 200, g: 70, b: 45 };

/**
 * Map one cell to an RGB colour. Writes into `out` to avoid a per-cell
 * allocation in the hot loop.
 */
export function cellRGB(world: WorldState, i: number, out: Rgb): void {
  const { width, layers, clock } = world;
  const x = i % width;
  const y = (i / width) | 0;
  const state = layers.fire.data[i];

  if (state === FireState.Burning) {
    // Flame colour by age: a young front burns white-hot, an old flame dies
    // deep red. Residence times are seconds (τ = 384/σ ≈ 7 s in grass), so an
    // asymptotic ramp t/(t+6) needs no per-fuel normalization. Flicker is two
    // incommensurate sines phased by the cell hash — clock-driven, RNG-free.
    const t = layers.burnElapsed.data[i];
    const age = t / (t + 6);
    const phase = hash01(i) * Math.PI * 2;
    const f =
      1 + 0.1 * Math.sin(clock.time * 9 + phase) + 0.06 * Math.sin(clock.time * 23 + phase * 1.7);
    if (age < 0.5) {
      const k = age * 2;
      out.r = 255 * f;
      out.g = lerp(238, 150, k) * f;
      out.b = lerp(170, 40, k) * f;
    } else {
      const k = (age - 0.5) * 2;
      out.r = lerp(255, 205, k) * f;
      out.g = lerp(150, 62, k) * f;
      out.b = lerp(40, 18, k) * f;
    }
    clampRgb(out);
    return;
  }

  if (state === FireState.Burned) {
    // Hash-varied char so the scar reads as texture, not a flat black blob.
    const j = (hash01(i) - 0.5) * 14;
    out.r = 36 + j;
    out.g = 30 + j * 0.8;
    out.b = 27 + j * 0.7;
    // The scar EDGE smolders. Honest to the mounted model (§D4): Burned cells
    // are permanent spread sources, so an edge still facing unburned burnable
    // fuel is never dead — it glows dim ember with a slow breathing pulse. An
    // edge against nonburnable (rock, water, a cut line) goes cold black — a
    // held line reads held; a merely-wetted edge keeps smoldering ("sleeping").
    // Flames actually arriving next door read brighter still.
    const edge = scarEdge(world, x, y);
    if (edge === 2) {
      out.r = out.r * 0.35 + 168 * 0.65;
      out.g = out.g * 0.35 + 70 * 0.65;
      out.b = out.b * 0.35 + 30 * 0.65;
    } else if (edge === 1) {
      const f = 0.75 + 0.25 * Math.sin(clock.time * 1.5 + hash01(i) * Math.PI * 2);
      out.r = out.r * 0.5 + 122 * 0.5 * f;
      out.g = out.g * 0.5 + 48 * 0.5 * f;
      out.b = out.b * 0.5 + 22 * 0.5 * f;
    }
    clampRgb(out);
    return;
  }

  const shade = hillshade(world, i, x, y);
  // Small static per-cell brightness jitter breaks up the fuel-band posterization.
  const tex = 1 + (hash01(i) - 0.5) * 0.1;
  const retardant = layers.retardant.data[i];
  const fuelId = layers.fuel.data[i];
  const dry = FUEL_DRY[fuelId];

  if (dry !== undefined) {
    const wet = FUEL_WET[fuelId];
    const w = Math.min(1, layers.moisture.data[i] / 255 / WET_FULL);
    const s = shade * tex;
    out.r = lerp(dry.r, wet.r, w) * s;
    out.g = lerp(dry.g, wet.g, w) * s;
    out.b = lerp(dry.b, wet.b, w) * s;
  } else if (fuelId === Fuel.CutLine) {
    // Firefighter control line: a tan scratch of bared mineral soil, distinct
    // from grey rock so a hand/dozer line reads as built, not natural.
    const s = shade * tex;
    out.r = 194 * s;
    out.g = 168 * s;
    out.b = 120 * s;
  } else {
    // Nonburnable is either low-lying water or high bare rock; terrain gen puts
    // water below ~300 m and rock above ~820 m, so split on elevation instead of
    // painting mountain peaks lake-blue.
    const elev = layers.elevation.data[i];
    if (elev > 600) {
      const s = shade * tex;
      out.r = 128 * s;
      out.g = 125 * s;
      out.b = 118 * s; // bare rock — hillshade does the work
    } else {
      // Water: depth-shaded (deeper = darker) with a slow deterministic shimmer.
      const depth = Math.min(1, Math.max(0, 1 - elev / 300));
      const f = 1 + 0.05 * Math.sin(clock.time * 0.8 + hash01(i) * Math.PI * 2);
      out.r = lerp(72, 34, depth) * f;
      out.g = lerp(108, 60, depth) * f;
      out.b = lerp(152, 108, depth) * f;
    }
  }

  // Slurry overlay: blend the base colour toward retardant rust by remaining
  // potency (0..255). A fresh drop reads strong; the line fades as it decays.
  if (retardant > 0) {
    const a = (retardant / 255) * 0.75; // cap so terrain still shows through
    out.r = out.r * (1 - a) + RETARDANT_RGB.r * a;
    out.g = out.g * (1 - a) + RETARDANT_RGB.g * a;
    out.b = out.b * (1 - a) + RETARDANT_RGB.b * a;
  }
  clampRgb(out);
}

function clampRgb(out: Rgb): void {
  out.r = out.r > 255 ? 255 : out.r < 0 ? 0 : out.r;
  out.g = out.g > 255 ? 255 : out.g < 0 ? 0 : out.g;
  out.b = out.b > 255 ? 255 : out.b < 0 ? 0 : out.b;
}

/**
 * Classify a Burned cell's place on the scar: 2 = an 8-neighbour is actively
 * Burning; 1 = an 8-neighbour is unburned burnable fuel (the live edge, §D4);
 * 0 = interior (or fully contained by nonburnable) — cold char.
 */
function scarEdge(world: WorldState, x: number, y: number): 0 | 1 | 2 {
  const { width, height } = world;
  const fire = world.layers.fire.data;
  const fuel = world.layers.fuel.data;
  let edge: 0 | 1 = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const ni = ny * width + nx;
      if (fire[ni] === FireState.Burning) return 2;
      if (fire[ni] === FireState.Unburned && FUEL_DRY[fuel[ni]] !== undefined) edge = 1;
    }
  }
  return edge;
}

/** Glow the post-pass adds around each burning cell: [dRed, dGreen] at r=1, r=2. */
const GLOW_NEAR_R = 34;
const GLOW_NEAR_G = 13;
const GLOW_FAR_R = 12;
const GLOW_FAR_G = 4;

/**
 * Compose a full frame into `rgba` (length ≥ width·height·4): per-cell colours,
 * then an additive warm glow around every burning cell — a cheap bloom that
 * makes the fire read at a glance. Clamps manually because callers pass plain
 * `Uint8Array`s (the PNG exporter), which would wrap, not clamp.
 */
export function renderRGBA(world: WorldState, rgba: Uint8Array | Uint8ClampedArray): void {
  const { width, height } = world;
  const n = width * height;
  const rgb: Rgb = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    cellRGB(world, i, rgb);
    const p = i * 4;
    rgba[p] = rgb.r;
    rgba[p + 1] = rgb.g;
    rgba[p + 2] = rgb.b;
    rgba[p + 3] = 255;
  }

  // Glow post-pass: O(burning · 24), cheap next to the main loop.
  const fire = world.layers.fire.data;
  for (let i = 0; i < n; i++) {
    if (fire[i] !== FireState.Burning) continue;
    const x = i % width;
    const y = (i / width) | 0;
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        const p = (ny * width + nx) * 4;
        const dr = ring === 1 ? GLOW_NEAR_R : GLOW_FAR_R;
        const dg = ring === 1 ? GLOW_NEAR_G : GLOW_FAR_G;
        const r = rgba[p] + dr;
        const g = rgba[p + 1] + dg;
        rgba[p] = r > 255 ? 255 : r;
        rgba[p + 1] = g > 255 ? 255 : g;
      }
    }
  }
}
