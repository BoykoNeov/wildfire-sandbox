import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel, ANDERSON_13, deadFuelBed } from '../src/sim/anderson13';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import { surfaceSpread, ftPerMinToMetersPerSec } from '../src/sim/rothermel';
import { byteToFraction } from '../src/core/moisture';

/**
 * Step-4 acceptance gate (Phase-2 plan §D4): the Rothermel fire model's measured
 * front speed must equal the analytic Rothermel rate of spread.
 *
 * Geometry matters (see the model header): `max`-accumulation is exactly R0 along
 * the 8 neighbour rays but ~8% slow between them, so we measure a **planar
 * cardinal front** (not a radius). We also make one cell take many ticks to cross
 * (`TICKS_PER_CELL` ≫ 1) over many cells, so neither the per-tick rounding (up to
 * `dt` late) nor the ±1-cell counting error dominates — letting us assert a tight
 * tolerance. The target is `surfaceSpread`'s own R0, so this checks *propagation*;
 * the science itself is validated against literature in `rothermel.test.ts`.
 */

const FM = 1; // FM1 short grass — a clean single-class dead bed.
const MOIST_BYTE = 15; // ≈ 6% dead-fuel moisture (byteToFraction(15) ≈ 0.059).

/** Analytic no-wind/no-slope R0 [m/s] for the test fuel, straight from the pure module. */
function analyticR0Mps(): number {
  const model = ANDERSON_13.get(FM)!;
  const bed = deadFuelBed(model, byteToFraction(MOIST_BYTE));
  const { rateOfSpread } = surfaceSpread(bed, { midflameWind: 0, tanSlope: 0 });
  return ftPerMinToMetersPerSec(rateOfSpread);
}

/**
 * A homogeneous, flat, windless field with the whole left column alight — a planar
 * front that advances in +x. No weather provider, so wind stays zero; elevation
 * stays zero, so ROS is isotropic and equal to R0.
 */
function planarFrontWorld(cellSize: number, width: number, height: number): WorldState {
  const world = createWorld({ width, height, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST_BYTE);
  for (let y = 0; y < height; y++) world.layers.fire.set(0, y, FireState.Burning);
  return world;
}

/** Furthest ignited column (Burning or Burned) along the middle row. */
function frontColumn(world: WorldState): number {
  const my = world.height >> 1;
  let front = 0;
  for (let x = 0; x < world.width; x++) {
    const s = world.layers.fire.get(x, my);
    if (s === FireState.Burning || s === FireState.Burned) front = x;
  }
  return front;
}

describe('Rothermel fire model — front speed equals analytic ROS', () => {
  it('a planar cardinal front advances at the Rothermel R0', () => {
    const R0 = analyticR0Mps();
    expect(R0).toBeGreaterThan(0); // sanity: this fuel/moisture actually carries fire

    const dt = 1;
    const TICKS_PER_CELL = 40; // crossing time ≫ dt → small per-tick rate bias
    const cellSize = TICKS_PER_CELL * dt * R0; // one cell ≈ 40 ticks of front travel
    const STEPS = 1200; // ideal front = STEPS / TICKS_PER_CELL = 30 cells
    const width = 40;
    const height = 5;

    const world = planarFrontWorld(cellSize, width, height);
    new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel())]).run(STEPS, dt);

    const measuredSpeed = (frontColumn(world) * cellSize) / (STEPS * dt);
    const ratio = measuredSpeed / R0;
    // Within ~±5% of the analytic ROS: ~30 cells in ~1200 ticks lands at ~29/30.
    // Slightly slow is expected (Euler late-firing + the ±1-cell counting floor);
    // never faster than R0, because `max` caps each direction at the analytic rate.
    // This still rejects the rejected sum formulation (≈2.41× overspeed) and a
    // stalled front (ratio → 0).
    expect(ratio).toBeGreaterThan(0.93);
    expect(ratio).toBeLessThanOrEqual(1.02);
  });

  it('wind biases the front downwind (φw direction projection)', () => {
    // Same dry homogeneous field, but wind blows toward +x. The downwind front
    // should outrun the crosswind front, which advances at the no-wind baseline.
    const cellSize = 40 * analyticR0Mps(); // crosswind ≈ 1 cell / 40 ticks
    const w = 81;
    const h = 81;
    const cx = w >> 1;
    const cy = h >> 1;
    const world = createWorld({ width: w, height: h, seed: 1, cellSize });
    world.layers.fuel.data.fill(FM);
    world.layers.moisture.data.fill(MOIST_BYTE);
    world.layers.fire.set(cx, cy, FireState.Burning);

    new Simulation(world, [
      new UniformWeatherProvider(3, 0), // ≈ 3 m/s midflame toward +x
      new RothermelFireModel(new Anderson13FuelModel()),
    ]).run(400, 1);

    const ignited = (x: number, y: number): boolean =>
      world.layers.fire.get(x, y) !== FireState.Unburned;

    let downwind = 0;
    for (let x = cx + 1; x < w && ignited(x, cy); x++) downwind = x - cx;
    let crosswind = 0;
    for (let y = cy + 1; y < h && ignited(cx, y); y++) crosswind = y - cy;

    expect(crosswind).toBeGreaterThan(0); // crosswind still carries at baseline R0
    expect(downwind).toBeGreaterThan(crosswind); // …but wind drives it much further
  });

  it('does not spread when moisture is at/above the moisture of extinction', () => {
    // 60% dead-fuel moisture ≫ FM1 Mx (0.12) → η_M = 0 → R0 = 0 → front stays put.
    const world = createWorld({ width: 16, height: 5, seed: 1, cellSize: 30 });
    world.layers.fuel.data.fill(FM);
    world.layers.moisture.data.fill(Math.round(0.6 * 255));
    for (let y = 0; y < world.height; y++) world.layers.fire.set(0, y, FireState.Burning);

    new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel())]).run(200, 1);
    expect(frontColumn(world)).toBe(0); // never left the ignition column
  });
});

describe('Rothermel fire model — determinism', () => {
  it('same setup twice → byte-for-byte identical fire', () => {
    const R0 = analyticR0Mps();
    const cellSize = 40 * R0;
    const run = (): Uint8Array => {
      const world = planarFrontWorld(cellSize, 24, 5);
      new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel())]).run(300, 1);
      return world.layers.fire.data.slice();
    };
    expect(Array.from(run())).toEqual(Array.from(run()));
  });
});
