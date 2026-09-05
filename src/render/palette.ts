import { FireState, type WorldState } from '../core/world';
import { Fuel } from '../sim/basicFuelModel';
import { CrownFire } from '../sim/crownFire';

/**
 * What the unburned landscape shows. Fire (flames, char, the live scar edge) is
 * drawn identically on every view so the front always reads; the views only
 * change what the ground underneath encodes:
 *  - `terrain`   — the composed scene: fuel colour × moisture tint × hillshade,
 *                  with contour lines and smoke plumes (the only view with smoke).
 *  - `fuel`      — flat fuel classes (grass / brush / timber / rock / water / line).
 *  - `moisture`  — dead-fuel moisture, dry brown → wet blue (the layer that
 *                  decides everything; drops, knockdowns and drying read directly).
 *  - `elevation` — hypsometric tint + hillshade + contours.
 *  - `canopy`    — canopy byte, bare → dense green (what can shelter, crown, spot).
 *  - `intensity` — burned cells by the fireline intensity that took them, a
 *                  heat ramp; unburned ground dimmed. The "how hard did it burn
 *                  here" map, with crown runs at the top of the ramp.
 */
export type ViewMode = 'terrain' | 'fuel' | 'moisture' | 'elevation' | 'canopy' | 'intensity';

export const VIEW_MODES: ReadonlyArray<{ id: ViewMode; label: string }> = [
  { id: 'terrain', label: 'Terrain' },
  { id: 'fuel', label: 'Fuel' },
  { id: 'moisture', label: 'Moisture' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'canopy', label: 'Canopy' },
  { id: 'intensity', label: 'Intensity' },
];

export interface RenderOptions {
  view?: ViewMode;
  /** Draw smoke plumes (terrain view only). Default true. */
  smoke?: boolean;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Shared colour composition for every renderer (the on-screen canvas and the
 * headless PNG exporter) so they never drift: `cellRGB` maps one cell to RGB,
 * `renderRGBA` composes a whole frame (per-cell colours + smoke + the fire-glow
 * post-pass) into an RGBA buffer. Renderers are thin byte-copiers on top.
 *
 * Everything here is a **pure read** of world state (Phase-5 plan, decision #1).
 * Animated effects (flame flicker, water shimmer, drifting smoke) derive from
 * `clock.time` plus an integer hash of the cell index — NEVER from `world.rng`,
 * which would consume draws the sim expects and desync the determinism golden
 * (plan decision #2).
 *
 * **Per-world render cache.** Hillshade, contour lines and the per-cell texture
 * hash are static until someone paints elevation, so they are computed once into
 * a {@link TerrainCache} and reused every frame (this halved the frame cost at
 * 256²). The cache is keyed by world in a `WeakMap`, so `renderRGBA`'s signature
 * is unchanged and the headless exporter gets it for free; the editor calls
 * {@link invalidateTerrainShading} after a stroke that changes elevation or fuel.
 * The cache also owns the smoke accumulators (which persist between frames — see
 * the smoke section) and the scar-edge list, so the frame loop allocates nothing.
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

/** Contour interval [m] drawn on the terrain / elevation views. */
export const CONTOUR_INTERVAL_M = 50;
/** Brightness multiplier of a contour cell (a thin, darker index line). */
const CONTOUR_SHADE = 0.87;
/** Elevation at/below which a nonburnable cell is water (terrain gen: water < ~300 m, rock > ~820 m). */
const WATER_MAX_ELEV = 600;

/**
 * A cell sits on a contour line when the contour band changes between it and
 * its west or north neighbour — one cell wide, so lines stay thin at any zoom.
 * Under water the terrain is invisible, so no line is drawn there.
 */
function isContour(world: WorldState, i: number, x: number, y: number): boolean {
  const { width, layers } = world;
  const e = layers.elevation.data;
  if (layers.fuel.data[i] === Fuel.Nonburnable && e[i] <= WATER_MAX_ELEV) return false;
  const band = Math.floor(e[i] / CONTOUR_INTERVAL_M);
  if (x > 0 && Math.floor(e[i - 1] / CONTOUR_INTERVAL_M) !== band) return true;
  if (y > 0 && Math.floor(e[i - width] / CONTOUR_INTERVAL_M) !== band) return true;
  return false;
}

/** Static per-world shading + per-frame scratch (see the module header). */
interface TerrainCache {
  /** hillshade × texture jitter × contour, per cell. */
  shade: Float32Array;
  /** `hash01(i)` per cell. */
  noise: Float32Array;
  /** Smoke optical depth accumulator, per cell. Persists between frames (amortised). */
  smoke: Float32Array;
  /** Soot-weighted smoke accumulator, per cell — colours the plume grey→dark. */
  soot: Float32Array;
  /** Indices of Burned cells on the live scar edge this frame + their count. */
  edge: Int32Array;
  edgeCount: number;
  /**
   * Frames rendered with smoke on since the last cold start. 0 means the smoke
   * field is empty and the next frame must lay every source (see the smoke
   * section); otherwise `& 3` selects which quarter of the sources lays this frame.
   */
  frameCounter: number;
  dirty: boolean;
}

const caches = new WeakMap<WorldState, TerrainCache>();

function cacheFor(world: WorldState): TerrainCache {
  let c = caches.get(world);
  const n = world.width * world.height;
  if (c === undefined || c.shade.length !== n) {
    c = {
      shade: new Float32Array(n),
      noise: new Float32Array(n),
      smoke: new Float32Array(n),
      soot: new Float32Array(n),
      edge: new Int32Array(n),
      edgeCount: 0,
      frameCounter: 0,
      dirty: true,
    };
    caches.set(world, c);
  }
  if (c.dirty) {
    const { width } = world;
    for (let i = 0; i < n; i++) {
      const x = i % width;
      const y = (i / width) | 0;
      const h = hash01(i);
      c.noise[i] = h;
      // Small static per-cell brightness jitter breaks up the fuel-band posterization.
      let s = hillshade(world, i, x, y) * (1 + (h - 0.5) * 0.1);
      if (isContour(world, i, x, y)) s *= CONTOUR_SHADE;
      c.shade[i] = s;
    }
    c.dirty = false;
  }
  return c;
}

/**
 * Mark a world's static shading (hillshade, contours, texture) stale — call after
 * painting the `elevation` or `fuel` layer. Cheap; the rebuild happens lazily on
 * the next frame.
 */
export function invalidateTerrainShading(world: WorldState): void {
  const c = caches.get(world);
  if (c) c.dirty = true;
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
/**
 * The same endpoints as flat typed arrays indexed `fuelId*3 + channel`, for the
 * per-frame hot path (a `Record` lookup per cell per frame is a dictionary probe;
 * this is a load). `FUEL_HAS_BED[fuelId]` = 1 when the fuel has dry/wet colours.
 */
const FUEL_DRY_T = new Float32Array(8 * 3);
const FUEL_WET_T = new Float32Array(8 * 3);
const FUEL_HAS_BED = new Uint8Array(8);
for (const idStr of Object.keys(FUEL_DRY)) {
  const id = Number(idStr);
  const d = FUEL_DRY[id];
  const w = FUEL_WET[id];
  FUEL_DRY_T[id * 3] = d.r;
  FUEL_DRY_T[id * 3 + 1] = d.g;
  FUEL_DRY_T[id * 3 + 2] = d.b;
  FUEL_WET_T[id * 3] = w.r;
  FUEL_WET_T[id * 3 + 1] = w.g;
  FUEL_WET_T[id * 3 + 2] = w.b;
  FUEL_HAS_BED[id] = 1;
}

/** Aerial fire-retardant (Phos-Chek-style) rust-red slurry. */
const RETARDANT_RGB: Rgb = { r: 200, g: 70, b: 45 };

/**
 * Map one cell to an RGB colour. Writes into `out` to avoid a per-cell
 * allocation in the hot loop. `shade`/`noise` are the cached static terms
 * (see {@link TerrainCache}); computed on the fly when omitted. `edge` is the
 * cell's {@link scarEdge} class when the caller already has it.
 */
export function cellRGB(
  world: WorldState,
  i: number,
  out: Rgb,
  view: ViewMode = 'terrain',
  shade?: number,
  noise?: number,
  edge?: 0 | 1 | 2,
): void {
  const { width, layers, clock } = world;
  const x = i % width;
  const y = (i / width) | 0;
  const state = layers.fire.data[i];
  const h = noise ?? hash01(i);

  if (state === FireState.Burning) {
    // Flame colour by age: a young front burns white-hot, an old flame dies
    // deep red. Residence times are seconds (τ = 384/σ ≈ 7 s in grass), so an
    // asymptotic ramp t/(t+6) needs no per-fuel normalization. Flicker is two
    // incommensurate sines phased by the cell hash — clock-driven, RNG-free.
    const t = layers.burnElapsed.data[i];
    const age = t / (t + 6);
    const phase = h * Math.PI * 2;
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
    // Crown fire burns hotter and taller: an active run reads white-hot with a
    // blue-white core, torching reads as a brighter, yellower flame. Both are
    // the fire model's own verdict (`layers.crown`), not a guess from canopy.
    const cr = layers.crown.data[i];
    if (cr === CrownFire.Active) {
      out.r = out.r * 0.35 + 255 * 0.65;
      out.g = out.g * 0.35 + 246 * 0.65;
      out.b = out.b * 0.35 + 230 * 0.65;
    } else if (cr === CrownFire.Passive) {
      out.r = out.r * 0.6 + 255 * 0.4;
      out.g = out.g * 0.6 + 214 * 0.4;
      out.b = out.b * 0.6 + 120 * 0.4;
    }
    clampRgb(out);
    return;
  }

  if (state === FireState.Burned) {
    if (view === 'intensity') {
      // Heat ramp by the recorded fireline intensity (kW/m, log-scaled: 10 →
      // 10 000 spans creeping surface fire → active crown run).
      heatRamp(layers.intensity.data[i], out);
      clampRgb(out);
      return;
    }
    // Hash-varied char so the scar reads as texture, not a flat black blob. A
    // crown-consumed cell is pale grey ash (the canopy is gone); a surface burn
    // under an intact canopy keeps the dark brown-black char.
    const j = (h - 0.5) * 14;
    const cr = layers.crown.data[i];
    if (cr === CrownFire.Active) {
      out.r = 118 + j;
      out.g = 112 + j;
      out.b = 104 + j;
    } else if (cr === CrownFire.Passive) {
      out.r = 74 + j;
      out.g = 66 + j * 0.9;
      out.b = 58 + j * 0.8;
    } else {
      out.r = 36 + j;
      out.g = 30 + j * 0.8;
      out.b = 27 + j * 0.7;
    }
    // The scar EDGE smolders. Honest to the mounted model (§D4): Burned cells
    // are permanent spread sources, so an edge still facing unburned burnable
    // fuel is never dead — it glows dim ember with a slow breathing pulse. An
    // edge against nonburnable (rock, water, a cut line) goes cold black — a
    // held line reads held; a merely-wetted edge keeps smoldering ("sleeping").
    // Flames actually arriving next door read brighter still.
    const e = edge ?? scarEdge(world, x, y);
    if (e === 2) {
      out.r = out.r * 0.35 + 168 * 0.65;
      out.g = out.g * 0.35 + 70 * 0.65;
      out.b = out.b * 0.35 + 30 * 0.65;
    } else if (e === 1) {
      const f = 0.75 + 0.25 * Math.sin(clock.time * 1.5 + h * Math.PI * 2);
      out.r = out.r * 0.5 + 122 * 0.5 * f;
      out.g = out.g * 0.5 + 48 * 0.5 * f;
      out.b = out.b * 0.5 + 22 * 0.5 * f;
    }
    clampRgb(out);
    return;
  }

  // Unburned: the static lighting term (hillshade × texture × contour).
  const s =
    shade ??
    hillshade(world, i, x, y) * (1 + (h - 0.5) * 0.1) * (isContour(world, i, x, y) ? CONTOUR_SHADE : 1);
  const retardant = layers.retardant.data[i];
  const fuelId = layers.fuel.data[i];

  if (view !== 'terrain') {
    dataView(world, i, view, fuelId, s, out);
    if (retardant > 0 && view !== 'intensity') blendRetardant(out, retardant);
    clampRgb(out);
    return;
  }

  terrainRGB(fuelId, layers.moisture.data[i], layers.elevation.data[i], s, h, clock.time, out);
  // Slurry overlay: blend the base colour toward retardant rust by remaining
  // potency (0..255). A fresh drop reads strong; the line fades as it decays.
  if (retardant > 0) blendRetardant(out, retardant);
  clampRgb(out);
}

/**
 * The `terrain` view's unburned ground colour (before retardant and clamping).
 * Takes the cell's raw layer values, not the world, so the frame loop can feed it
 * from hoisted typed arrays.
 */
function terrainRGB(
  fuelId: number,
  moistByte: number,
  elev: number,
  s: number,
  h: number,
  time: number,
  out: Rgb,
): void {
  if (fuelId < 8 && FUEL_HAS_BED[fuelId] === 1) {
    const w = Math.min(1, moistByte / 255 / WET_FULL);
    const k = fuelId * 3;
    out.r = (FUEL_DRY_T[k] + (FUEL_WET_T[k] - FUEL_DRY_T[k]) * w) * s;
    out.g = (FUEL_DRY_T[k + 1] + (FUEL_WET_T[k + 1] - FUEL_DRY_T[k + 1]) * w) * s;
    out.b = (FUEL_DRY_T[k + 2] + (FUEL_WET_T[k + 2] - FUEL_DRY_T[k + 2]) * w) * s;
  } else if (fuelId === Fuel.CutLine) {
    // Firefighter control line: a tan scratch of bared mineral soil, distinct
    // from grey rock so a hand/dozer line reads as built, not natural.
    out.r = 194 * s;
    out.g = 168 * s;
    out.b = 120 * s;
  } else {
    // Nonburnable is either low-lying water or high bare rock; terrain gen puts
    // water below ~300 m and rock above ~820 m, so split on elevation instead of
    // painting mountain peaks lake-blue.
    if (elev > WATER_MAX_ELEV) {
      out.r = 128 * s;
      out.g = 125 * s;
      out.b = 118 * s; // bare rock — hillshade does the work
    } else {
      // Water: depth-shaded (deeper = darker) with a slow deterministic shimmer.
      const depth = Math.min(1, Math.max(0, 1 - elev / 300));
      const f = 1 + 0.05 * Math.sin(time * 0.8 + h * Math.PI * 2);
      out.r = lerp(72, 34, depth) * f;
      out.g = lerp(108, 60, depth) * f;
      out.b = lerp(152, 108, depth) * f;
    }
  }
}

function blendRetardant(out: Rgb, retardant: number): void {
  const a = (retardant / 255) * 0.75; // cap so terrain still shows through
  out.r = out.r * (1 - a) + RETARDANT_RGB.r * a;
  out.g = out.g * (1 - a) + RETARDANT_RGB.g * a;
  out.b = out.b * (1 - a) + RETARDANT_RGB.b * a;
}

/** Flat class colours for the `fuel` view. */
const FUEL_FLAT: Record<number, Rgb> = {
  [Fuel.Nonburnable]: { r: 120, g: 118, b: 112 },
  [Fuel.Grass]: { r: 214, g: 196, b: 92 },
  [Fuel.Brush]: { r: 150, g: 128, b: 60 },
  [Fuel.Timber]: { r: 48, g: 96, b: 52 },
  [Fuel.CutLine]: { r: 220, g: 190, b: 130 },
};
const WATER_FLAT: Rgb = { r: 58, g: 96, b: 150 };

/**
 * Fireline-intensity heat ramp: log10(kW/m) from 1 (10 kW/m, a creeping
 * surface fire) to 4 (10 000 kW/m, an active crown run): dark plum → red →
 * orange → yellow → white. Exported so the HUD legend draws the same ramp.
 */
export function heatRamp(kwPerM: number, out: Rgb): void {
  const t = Math.min(1, Math.max(0, (Math.log10(Math.max(kwPerM, 1)) - 1) / 3));
  if (t < 0.33) {
    const k = t / 0.33;
    out.r = lerp(60, 190, k);
    out.g = lerp(20, 30, k);
    out.b = lerp(70, 40, k);
  } else if (t < 0.66) {
    const k = (t - 0.33) / 0.33;
    out.r = lerp(190, 255, k);
    out.g = lerp(30, 150, k);
    out.b = lerp(40, 30, k);
  } else {
    const k = (t - 0.66) / 0.34;
    out.r = 255;
    out.g = lerp(150, 250, k);
    out.b = lerp(30, 220, k);
  }
}

/**
 * Dead-fuel moisture ramp (fraction → colour): 0% brown → 15% (the Anderson Mx
 * band) tan → 40%+ blue. Exported so the HUD legend draws the same ramp.
 */
export function moistureRamp(fraction: number, out: Rgb): void {
  const t = Math.min(1, Math.max(0, fraction / 0.4));
  if (t < 0.375) {
    const k = t / 0.375;
    out.r = lerp(150, 214, k);
    out.g = lerp(80, 190, k);
    out.b = lerp(30, 120, k);
  } else {
    const k = (t - 0.375) / 0.625;
    out.r = lerp(214, 40, k);
    out.g = lerp(190, 110, k);
    out.b = lerp(120, 220, k);
  }
}

/** Hypsometric tint (elevation fraction of 1000 m → colour), before hillshade. Exported for the legend. */
export function elevationRamp(fraction: number, out: Rgb): void {
  const t = Math.min(1, Math.max(0, fraction));
  if (t < 0.5) {
    const k = t / 0.5;
    out.r = lerp(80, 200, k);
    out.g = lerp(150, 180, k);
    out.b = lerp(80, 110, k);
  } else {
    const k = (t - 0.5) / 0.5;
    out.r = lerp(200, 235, k);
    out.g = lerp(180, 232, k);
    out.b = lerp(110, 228, k);
  }
}

/** Canopy ramp (byte fraction → colour): bare tan → dense dark green. Exported for the legend. */
export function canopyRamp(fraction: number, out: Rgb): void {
  const c = Math.min(1, Math.max(0, fraction));
  out.r = lerp(200, 20, c);
  out.g = lerp(190, 110, c);
  out.b = lerp(150, 40, c);
}

/** Unburned-cell colour for the data views (see {@link ViewMode}). */
function dataView(world: WorldState, i: number, view: ViewMode, fuelId: number, shade: number, out: Rgb): void {
  const { layers } = world;
  const elev = layers.elevation.data[i];
  const isWater = fuelId === Fuel.Nonburnable && elev <= WATER_MAX_ELEV;
  switch (view) {
    case 'fuel': {
      const c = isWater ? WATER_FLAT : (FUEL_FLAT[fuelId] ?? FUEL_FLAT[Fuel.Nonburnable]);
      const s = 0.8 + 0.2 * shade;
      out.r = c.r * s;
      out.g = c.g * s;
      out.b = c.b * s;
      return;
    }
    case 'moisture': {
      if (isWater || fuelId === Fuel.Nonburnable) {
        out.r = 80 * shade;
        out.g = 80 * shade;
        out.b = 84 * shade;
        return;
      }
      moistureRamp(layers.moisture.data[i] / 255, out);
      const s = 0.75 + 0.25 * shade;
      out.r *= s;
      out.g *= s;
      out.b *= s;
      return;
    }
    case 'elevation': {
      if (isWater) {
        out.r = 50;
        out.g = 90;
        out.b = 150;
        return;
      }
      // Hypsometric: low green → tan → brown → grey-white peaks, hillshaded.
      elevationRamp(elev / 1000, out);
      out.r *= shade;
      out.g *= shade;
      out.b *= shade;
      return;
    }
    case 'canopy': {
      if (isWater) {
        out.r = 50;
        out.g = 90;
        out.b = 150;
        return;
      }
      canopyRamp(layers.canopy.data[i] / 255, out);
      out.r *= shade;
      out.g *= shade;
      out.b *= shade;
      return;
    }
    case 'intensity':
    default: {
      // Dim, desaturated ground so the heat ramp on the scar carries the view.
      const base = isWater ? 40 : 70 + 40 * shade;
      out.r = base;
      out.g = base;
      out.b = isWater ? 70 : base;
      return;
    }
  }
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

// ───────────────────────── fire glow ─────────────────────────

/**
 * Glow kernel: the 24 cells around a burning cell with a radial falloff
 * (1 at distance 1 → 0.12 at 2√2), so the bloom is round, not a box. Weights
 * scale [dRed, dGreen] = [36, 14] × crown boost.
 */
const GLOW_DX: number[] = [];
const GLOW_DY: number[] = [];
const GLOW_W: number[] = [];
for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    if (dx === 0 && dy === 0) continue;
    const d = Math.sqrt(dx * dx + dy * dy);
    GLOW_DX.push(dx);
    GLOW_DY.push(dy);
    GLOW_W.push(Math.exp(-(d - 1) * 1.05));
  }
}
const GLOW_R = 36;
const GLOW_G = 14;

// ───────────────────────── smoke ─────────────────────────

/**
 * Smoke is a **visual cue, not a dispersion model** (`docs/science.md` §9): each
 * flaming cell and each smouldering scar-edge cell lays a plume of optical depth
 * downwind along the wind vector sampled at the source, tapering with distance,
 * widening as it goes, with a clock-driven meander and puff modulation so it
 * reads as drifting. Stateless — a pure function of the frame's world state —
 * so the headless PNG shows the same plume the browser does and nothing has to
 * be stepped. Flames stay legible: the plume starts one cell downwind and the
 * composite is capped at {@link SMOKE_MAX_ALPHA}.
 */
const SMOKE_MAX_ALPHA = 0.7;
/** Plume length [cells] = SMOKE_LEN_BASE + wind (m/s) × SMOKE_LEN_PER_MPS, capped. */
const SMOKE_LEN_BASE = 3;
const SMOKE_LEN_PER_MPS = 1.4;
const SMOKE_LEN_MAX = 28;
/**
 * Light (fresh, distant) and dark (sooty, near a crown run) smoke colours. The
 * light end is a cool off-white so it separates from warm grass and olive brush.
 */
const SMOKE_LIGHT: Rgb = { r: 224, g: 222, b: 226 };
const SMOKE_DARK: Rgb = { r: 84, g: 80, b: 78 };
/**
 * Source strengths. In the mounted model flames last seconds while a cell takes
 * minutes to cross, so at any instant only a handful of cells are literally
 * `Burning`; the *smouldering scar edge* is where most of the smoke honestly
 * comes from (Burned cells stay spread sources, §D4), so it gets a real plume,
 * not a token wisp. Flaming cells lay a thicker, longer, darker one on top.
 */
const SMOKE_FLAME_STRENGTH = 0.9;
const SMOKE_EDGE_STRENGTH = 0.38;
const SMOKE_EDGE_LEN_SCALE = 0.7;

/**
 * **Amortised smoke.** Laying every plume every frame is the renderer's biggest
 * cost on a large fire (≈ 1.9 ms/frame at 256² with ~300 flaming cells and a
 * 7 000-cell scar). Instead the smoke field *persists* between frames: each
 * frame decays it by {@link SMOKE_DECAY} and re-lays only the quarter of the
 * sources whose schedule hash falls in this frame's slot — a quarter of the
 * plume work for a field that looks the same, only smoother.
 *
 * The deposit gain keeps the **time-averaged** optical depth equal to the old
 * stateless field. Depositing `g` every `K` frames under per-frame decay `d`
 * settles at a mean of `g / (K·(1−d))`, so `g = K·(1−d)` = 0.6 reproduces the
 * unit-strength field exactly — depositing at the plan's "4×" would have been
 * ≈ 6.7× too thick and saturated everything to a grey blanket.
 *
 * A **cold start** (`frameCounter === 0`: a fresh world, or the first frame after
 * smoke was toggled off) lays every source at gain 1, which lands directly on
 * that same steady-state mean — so the one-frame headless PNG and the browser's
 * running field show the same plume, with no separate calibration.
 *
 * The schedule hash is deliberately *not* `cache.noise` (the scar-edge loop
 * already gates on that one; sharing it would confine every edge source to two
 * of the four slots and make the smoke pulse).
 */
const SMOKE_DECAY = 0.85;
const SMOKE_SLOTS = 4;
const SMOKE_AMORT_GAIN = SMOKE_SLOTS * (1 - SMOKE_DECAY);
/**
 * Optical depth below which a cell is zeroed during the decay pass. Without it
 * the persistent field leaves a long tail of near-zero values, the composite
 * pass's early-out stops firing, and the compositing gets *more* expensive than
 * it was stateless.
 */
const SMOKE_FLOOR = 0.004;

/** Second per-cell hash, for the amortisation schedule only. */
function schedHash01(i: number): number {
  return hash01(i ^ 0x5bf03635);
}

/**
 * Lay one plume from cell (x, y) into the accumulators. `strength` is the
 * optical depth at the source, `sooty` (0..1) how dark the plume is, `lenScale`
 * stretches the plume (a crown column reaches further).
 */
function layPlume(
  world: WorldState,
  cache: TerrainCache,
  x: number,
  y: number,
  i: number,
  strength: number,
  sooty: number,
  lenScale: number,
  lateral: number,
  gain: number,
): void {
  const { width, height, layers, clock } = world;
  const u = layers.windU.data[i];
  const v = layers.windV.data[i];
  const speed = Math.hypot(u, v);
  const phase = cache.noise[i] * Math.PI * 2;
  const t = clock.time;
  // Calm air: the column rises and spreads in place — a short blob, no direction.
  const calm = speed < 0.3;
  const dx = calm ? 0 : u / speed;
  const dy = calm ? 0 : v / speed;
  const len = calm ? 2 : Math.min(SMOKE_LEN_MAX, (SMOKE_LEN_BASE + speed * SMOKE_LEN_PER_MPS) * lenScale);
  const L = Math.max(1, Math.round(len));
  // Perpendicular unit for the meander / lateral spread.
  const px = -dy;
  const py = dx;
  const smoke = cache.smoke;
  const soot = cache.soot;
  for (let j = 1; j <= L; j++) {
    const f = j / L;
    // Puffs travel downwind: a wave in j moving with time; the meander bends the
    // plume axis more the further from the source.
    const puff = 0.72 + 0.28 * Math.sin(t * 1.6 - j * 0.9 + phase);
    const meander = Math.sin(t * 0.55 + phase + j * 0.32) * (0.25 + 0.16 * j);
    const cxF = x + 0.5 + dx * j + px * meander;
    const cyF = y + 0.5 + dy * j + py * meander;
    const a = strength * (1 - f) * (1 - f * 0.35) * puff;
    if (a <= 0.004) continue;
    const halfW = calm ? 1 + j : Math.min(lateral, 0.6 + 0.16 * j);
    const span = Math.ceil(halfW);
    const invW = 1 / (halfW + 0.5);
    for (let k = -span; k <= span; k++) {
      // Smooth bump (1 − (k/w)²)² — a Gaussian look without the exp per deposit.
      const q = 1 - k * k * invW * invW;
      if (q <= 0) continue;
      const w = q * q;
      const cx = Math.floor(cxF + px * k);
      const cy = Math.floor(cyF + py * k);
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      const ci = cy * width + cx;
      const d = a * w * gain;
      smoke[ci] += d;
      soot[ci] += d * sooty;
    }
  }
}

/**
 * Compose a full frame into `rgba` (length ≥ width·height·4): per-cell colours,
 * then (terrain view) smoke plumes, then an additive warm glow around every
 * burning cell — a cheap bloom that makes the fire read at a glance. Clamps
 * manually because callers pass plain `Uint8Array`s (the PNG exporter), which
 * would wrap, not clamp.
 */
export function renderRGBA(
  world: WorldState,
  rgba: Uint8Array | Uint8ClampedArray,
  opts: RenderOptions = {},
): void {
  const { width, height, layers } = world;
  const view = opts.view ?? 'terrain';
  const drawSmoke = (opts.smoke ?? true) && view === 'terrain';
  const n = width * height;
  const cache = cacheFor(world);
  const shade = cache.shade;
  const noise = cache.noise;
  const fire = layers.fire.data;
  const fuel = layers.fuel.data;
  const moist = layers.moisture.data;
  const elev = layers.elevation.data;
  const retardantL = layers.retardant.data;
  const time = world.clock.time;
  const rgb: Rgb = { r: 0, g: 0, b: 0 };
  let edgeCount = 0;

  for (let i = 0; i < n; i++) {
    const state = fire[i];
    if (state === FireState.Unburned && view === 'terrain') {
      // The hot path (nearly every cell, every frame): inline the terrain ground.
      terrainRGB(fuel[i], moist[i], elev[i], shade[i], noise[i], time, rgb);
      const ret = retardantL[i];
      if (ret > 0) blendRetardant(rgb, ret);
      clampRgb(rgb);
    } else if (state === FireState.Burned && view !== 'intensity') {
      const edge = scarEdge(world, i % width, (i / width) | 0);
      if (edge !== 0) cache.edge[edgeCount++] = i;
      cellRGB(world, i, rgb, view, shade[i], noise[i], edge);
    } else {
      cellRGB(world, i, rgb, view, shade[i], noise[i]);
    }
    // Already clamped to 0..255: truncate to an int so the typed-array store is a
    // plain byte write (a float store into a Uint8ClampedArray rounds+clamps again).
    const p = i * 4;
    rgba[p] = rgb.r | 0;
    rgba[p + 1] = rgb.g | 0;
    rgba[p + 2] = rgb.b | 0;
    rgba[p + 3] = 255;
  }
  cache.edgeCount = edgeCount;

  const crown = layers.crown.data;

  // Smoke off (a data view, or the HUD toggle): the persistent field goes stale
  // as the fire moves, so the next smoke-on frame starts cold rather than
  // resuming a plume anchored to where the fire used to be.
  if (!drawSmoke) cache.frameCounter = 0;

  if (drawSmoke) {
    const smoke = cache.smoke;
    const soot = cache.soot;
    // Cold start: no field to carry over, so lay every source at full gain.
    // Otherwise fade what is there and re-lay one quarter of the sources.
    const cold = cache.frameCounter === 0;
    const gain = cold ? 1 : SMOKE_AMORT_GAIN;
    const slot = cache.frameCounter & (SMOKE_SLOTS - 1);
    const slotLo = slot / SMOKE_SLOTS;
    const slotHi = (slot + 1) / SMOKE_SLOTS;
    if (cold) {
      smoke.fill(0);
      soot.fill(0);
    } else {
      for (let i = 0; i < n; i++) {
        const tau = smoke[i];
        if (tau === 0) continue;
        const decayed = tau * SMOKE_DECAY;
        if (decayed < SMOKE_FLOOR) {
          smoke[i] = 0;
          soot[i] = 0;
        } else {
          smoke[i] = decayed;
          soot[i] *= SMOKE_DECAY;
        }
      }
    }
    const intensity = layers.intensity.data;
    // Flaming cells: a full plume, hotter fronts thicker, crown runs darker and longer.
    for (let i = 0; i < n; i++) {
      if (fire[i] !== FireState.Burning) continue;
      if (!cold) {
        const sch = schedHash01(i);
        if (sch < slotLo || sch >= slotHi) continue;
      }
      const cr = crown[i];
      const heat = Math.min(1, intensity[i] / 4000);
      const strength =
        SMOKE_FLAME_STRENGTH + 0.4 * heat + (cr === CrownFire.Active ? 0.4 : cr === CrownFire.Passive ? 0.2 : 0);
      const sooty = 0.3 + 0.35 * heat + (cr === CrownFire.Active ? 0.3 : 0);
      const lenScale = cr === CrownFire.Active ? 1.6 : cr === CrownFire.Passive ? 1.25 : 1;
      layPlume(world, cache, i % width, (i / width) | 0, i, strength, sooty, lenScale, 3, gain);
    }
    // The smouldering scar edge: paler, shorter plumes — but most of the smoke.
    // Every other edge cell (by its static hash) lays a plume at ~1.6× strength:
    // half the cost of one per cell, and the slight clumping reads as smoke does.
    for (let k = 0; k < edgeCount; k++) {
      const i = cache.edge[k];
      if (noise[i] < 0.5) continue;
      if (!cold) {
        const sch = schedHash01(i);
        if (sch < slotLo || sch >= slotHi) continue;
      }
      layPlume(world, cache, i % width, (i / width) | 0, i, SMOKE_EDGE_STRENGTH * 1.6, 0.12, SMOKE_EDGE_LEN_SCALE, 2, gain);
    }
    cache.frameCounter++;
    // Composite: optical depth → alpha (1 − e^−τ), colour by soot fraction.
    for (let i = 0; i < n; i++) {
      const tau = smoke[i];
      if (tau <= 0.003) continue;
      let a = 1 - Math.exp(-tau);
      if (a > SMOKE_MAX_ALPHA) a = SMOKE_MAX_ALPHA;
      const s = soot[i] / tau;
      const cr_ = lerp(SMOKE_LIGHT.r, SMOKE_DARK.r, s);
      const cg_ = lerp(SMOKE_LIGHT.g, SMOKE_DARK.g, s);
      const cb_ = lerp(SMOKE_LIGHT.b, SMOKE_DARK.b, s);
      const p = i * 4;
      rgba[p] = (rgba[p] + (cr_ - rgba[p]) * a) | 0;
      rgba[p + 1] = (rgba[p + 1] + (cg_ - rgba[p + 1]) * a) | 0;
      rgba[p + 2] = (rgba[p + 2] + (cb_ - rgba[p + 2]) * a) | 0;
    }
  }

  // Glow post-pass: O(burning · 24), cheap next to the main loop. A crowning
  // cell glows twice as strong — the whole stand is alight, not just the litter.
  // Drawn last so the flames punch through any smoke over them.
  for (let i = 0; i < n; i++) {
    if (fire[i] !== FireState.Burning) continue;
    const x = i % width;
    const y = (i / width) | 0;
    const boost = crown[i] === CrownFire.Active ? 2 : crown[i] === CrownFire.Passive ? 1.5 : 1;
    for (let k = 0; k < GLOW_DX.length; k++) {
      const nx = x + GLOW_DX[k];
      const ny = y + GLOW_DY[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const p = (ny * width + nx) * 4;
      const w = GLOW_W[k] * boost;
      const r = (rgba[p] + GLOW_R * w) | 0;
      const g = (rgba[p + 1] + GLOW_G * w) | 0;
      rgba[p] = r > 255 ? 255 : r;
      rgba[p + 1] = g > 255 ? 255 : g;
    }
  }
}
