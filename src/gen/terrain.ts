import { Rng } from '../core/rng';
import { FireState, type WorldState } from '../core/world';
import { Fuel } from '../sim/basicFuelModel';

/** Seeded fractal value noise — reproducible terrain from the world RNG. */
class ValueNoise {
  private readonly grid: Float32Array;

  constructor(
    rng: Rng,
    private readonly cols: number,
    private readonly rows: number,
  ) {
    this.grid = new Float32Array((cols + 1) * (rows + 1));
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = rng.next();
  }

  private corner(cx: number, cy: number): number {
    const x = Math.min(Math.max(cx, 0), this.cols);
    const y = Math.min(Math.max(cy, 0), this.rows);
    return this.grid[y * (this.cols + 1) + x];
  }

  /** Sample at normalized (u,v) in [0,1] with smoothstep interpolation. */
  sample(u: number, v: number): number {
    const fx = u * this.cols;
    const fy = v * this.rows;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const a = lerp(this.corner(x0, y0), this.corner(x0 + 1, y0), tx);
    const b = lerp(this.corner(x0, y0 + 1), this.corner(x0 + 1, y0 + 1), tx);
    return lerp(a, b, ty);
  }
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function fbm(octaves: ValueNoise[], u: number, v: number): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (const n of octaves) {
    sum += amp * n.sample(u, v);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

export interface TerrainOptions {
  /** Below this elevation fraction = water (nonburnable). */
  waterLevel?: number;
  /** Above this elevation fraction = bare rock (nonburnable). */
  rockLevel?: number;
}

/**
 * Generate the stacked terrain layers (Handoff §4.1) — elevation, fuel type,
 * moisture and canopy — from the world's seeded RNG, so the same seed yields the
 * same landscape.
 */
export function generateTerrain(world: WorldState, opts: TerrainOptions = {}): void {
  const { width, height, rng, layers } = world;
  const waterLevel = opts.waterLevel ?? 0.3;
  const rockLevel = opts.rockLevel ?? 0.82;

  const octaves = [
    new ValueNoise(rng, 4, 4),
    new ValueNoise(rng, 8, 8),
    new ValueNoise(rng, 16, 16),
    new ValueNoise(rng, 32, 32),
  ];
  const moistNoise = new ValueNoise(rng, 6, 6);

  const elev = layers.elevation.data;
  const fuel = layers.fuel.data;
  const moist = layers.moisture.data;
  const canopy = layers.canopy.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const u = x / (width - 1);
      const v = y / (height - 1);
      const e = fbm(octaves, u, v); // 0..1
      elev[i] = e * 1000; // metres

      if (e < waterLevel) {
        fuel[i] = Fuel.Nonburnable; // water
        canopy[i] = 0;
        moist[i] = 255;
      } else if (e > rockLevel) {
        fuel[i] = Fuel.Nonburnable; // bare rock
        canopy[i] = 0;
        moist[i] = 40;
      } else {
        const band = (e - waterLevel) / (rockLevel - waterLevel); // 0..1
        if (band < 0.4) fuel[i] = Fuel.Grass;
        else if (band < 0.75) fuel[i] = Fuel.Brush;
        else fuel[i] = Fuel.Timber;
        canopy[i] = fuel[i] === Fuel.Timber ? 200 : fuel[i] === Fuel.Brush ? 90 : 10;
        moist[i] = Math.round(20 + moistNoise.sample(u, v) * 80); // 20..100, fairly dry
      }
    }
  }
}

/** Force a cell to start burning (a sandbox ignition point). */
export function ignite(world: WorldState, x: number, y: number): void {
  const { layers } = world;
  if (!layers.fire.inBounds(x, y)) return;
  layers.fire.set(x, y, FireState.Burning);
  layers.burnElapsed.set(x, y, 0);
}

/**
 * Ignite the nearest burnable cell to (cx, cy), searching outward in square
 * rings. Keeps a demo ignition from silently landing on water/rock and looking
 * broken. Returns true if a burnable cell was found and lit.
 */
export function igniteNearestBurnable(world: WorldState, cx: number, cy: number): boolean {
  const { width, height, layers } = world;
  const fuel = layers.fuel.data;
  const maxR = Math.max(width, height);
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (fuel[y * width + x] !== Fuel.Nonburnable) {
          ignite(world, x, y);
          return true;
        }
      }
    }
  }
  return false;
}
