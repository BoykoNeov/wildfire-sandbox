import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel, ANDERSON_13, deadFuelBed } from '../src/sim/anderson13';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { CaFireModel } from '../src/sim/caFireModel';
import { BasicFuelModel, Fuel } from '../src/sim/basicFuelModel';
import { surfaceSpread, ftPerMinToMetersPerSec } from '../src/sim/rothermel';
import { byteToFraction } from '../src/core/moisture';

/**
 * Pins the Phase-3 wind-sampling convention (see `world.ts` windU/windV): **both
 * fire models sample wind at the DESTINATION cell** — the cell the front spreads
 * into — not at the source (burning) neighbour. Moot under uniform wind; these
 * tests make it bite by writing a *spatially-varying* wind field directly and
 * asserting the outcome that only destination-sampling produces.
 *
 * Geometry: a 1-cell-tall row  L — C — R  with only C alight. In a 3×1 grid L and
 * R each have exactly one in-bounds neighbour (C), so this is a clean 1-D probe —
 * no diagonals, no other sources.
 */

const FM = 1; // FM1 short grass — a clean single-class dead bed.
const MOIST_BYTE = 15; // ≈ 6% dead-fuel moisture — carries fire.

/** Analytic no-wind R0 [m/s] for the test fuel, so we can size the cell sensibly. */
function analyticR0Mps(): number {
  const bed = deadFuelBed(ANDERSON_13.get(FM)!, byteToFraction(MOIST_BYTE));
  return ftPerMinToMetersPerSec(surfaceSpread(bed, { midflameWind: 0, tanSlope: 0 }).rateOfSpread);
}

/** A 3×1 world with fuel/moisture filled and the centre cell (1,0) alight. */
function rowWorld(cellSize: number): WorldState {
  const world = createWorld({ width: 3, height: 1, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST_BYTE);
  world.layers.fire.set(1, 0, FireState.Burning);
  return world;
}

const ignited = (w: WorldState, x: number): boolean =>
  w.layers.fire.get(x, 0) !== FireState.Unburned;

describe('wind-sampling convention — Rothermel (exact arithmetic)', () => {
  it('east wind placed at the destination cell R speeds spread INTO R, not into L', () => {
    // Cell size so one no-wind cell-crossing takes many ticks — a clear window in
    // which the wind-boosted destination ignites while the windless one has not.
    const cellSize = 40 * analyticR0Mps();
    const world = rowWorld(cellSize);
    // Spatial step: strong east wind ONLY at R (2,0); zero at C and L.
    world.layers.windU.data[2] = 5; // m/s east, at the destination cell R
    // (windU[C]=windU[L]=0.) A source-sampling model would read wind@C=0 for BOTH
    // R and L and stay symmetric; destination-sampling boosts only R.

    const sim = new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel())]);
    let steps = 0;
    while (!ignited(world, 2) && steps < 200) {
      sim.step(1);
      steps++;
    }

    expect(ignited(world, 2)).toBe(true); // R (with wind at R) did ignite…
    expect(ignited(world, 0)).toBe(false); // …while L (no wind at L) has not yet.
  });

  it('east wind placed at the SOURCE cell C is ignored — spread stays symmetric', () => {
    // The complement: put the wind at the burning source C only. Under destination
    // sampling neither R nor L reads it (both read wind@self = 0), so they must
    // ignite on the *same* tick. Under source sampling R would outrun L.
    const cellSize = 40 * analyticR0Mps();
    const world = rowWorld(cellSize);
    world.layers.windU.data[1] = 5; // east wind at the SOURCE cell C only

    const sim = new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel())]);
    let steps = 0;
    while (!ignited(world, 2) && !ignited(world, 0) && steps < 200) {
      sim.step(1);
      steps++;
    }

    // Symmetric arrival: the first tick that ignites either flank ignites both.
    expect(ignited(world, 2)).toBe(true);
    expect(ignited(world, 0)).toBe(true);
  });
});

describe('wind-sampling convention — CaFireModel (RNG-free diagnostic)', () => {
  it('strong wind at destination R forces certain ignition regardless of seed', () => {
    // The CA ignites when rng.next() < pIgnite. A huge east wind at the destination
    // cell R drives pIgnite there to its clamp of 1, so rng.next() (< 1 always) can
    // never miss — R ignites in one step for EVERY seed. Were the CA reading wind at
    // the source C (= 0), pIgnite@R would be the sub-1 baseline and some seed would
    // fail. So "certain across seeds" is diagnostic of destination sampling.
    for (const seed of [1, 2, 7, 42, 1337, 99999]) {
      const world = createWorld({ width: 3, height: 1, seed, cellSize: 30 });
      world.layers.fuel.data.fill(Fuel.Grass);
      world.layers.moisture.data.fill(0); // moistFactor = 1
      world.layers.fire.set(1, 0, FireState.Burning);
      world.layers.windU.data[2] = 10; // strong east wind AT destination R

      new Simulation(world, [new CaFireModel(new BasicFuelModel())]).step(1);

      expect(world.layers.fire.get(2, 0)).toBe(FireState.Burning); // R ignited, all seeds
    }
  });
});
