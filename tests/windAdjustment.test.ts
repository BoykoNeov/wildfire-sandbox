import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel, ANDERSON_13, deadFuelBed } from '../src/sim/anderson13';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import { surfaceSpread, ftPerMinToMetersPerSec } from '../src/sim/rothermel';
import { byteToFraction } from '../src/core/moisture';
import {
  unshelteredWaf,
  shelteredWaf,
  crownFillPortion,
  windAdjustmentFactor,
  SHELTER_THRESHOLD_FILL,
} from '../src/sim/windAdjustment';

/**
 * Wind adjustment factor (Albini & Baughman 1979; Andrews 2012 RMRS-GTR-266).
 * Unsheltered values are pinned against the BehavePlus WAF table for the
 * Anderson 13 models (an independent published source); sheltering is checked
 * for its physical ordering and against a hand-worked value.
 */

describe('unsheltered WAF vs the BehavePlus fuel-model table', () => {
  // Anderson number → published unsheltered WAF (BehavePlus, 2 d.p.).
  const TABLE: Array<[number, number]> = [
    [1, 0.36],
    [3, 0.44],
    [4, 0.55],
    [5, 0.42],
    [8, 0.28],
    [10, 0.36],
    [12, 0.43],
    [13, 0.46],
  ];
  for (const [fm, waf] of TABLE) {
    it(`FM${fm} (depth ${ANDERSON_13.get(fm)!.depth} ft) → ${waf}`, () => {
      expect(unshelteredWaf(ANDERSON_13.get(fm)!.depth)).toBeCloseTo(waf, 2);
    });
  }
  it('is 0 for a degenerate zero-depth bed', () => {
    expect(unshelteredWaf(0)).toBe(0);
  });
});

describe('sheltered WAF', () => {
  it('hand-worked: 60 ft canopy, 70% cover, crown ratio 0.5 → ≈0.125', () => {
    const f = crownFillPortion(0.7, 0.5); // 0.1167
    expect(f).toBeCloseTo(0.11667, 5);
    // 0.555 / ( √(0.11667·60) · ln((20+21.6)/7.8) ) = 0.555 / (2.6458 · 1.6740)
    expect(shelteredWaf(60, f)).toBeCloseTo(0.1253, 3);
  });

  it('a sheltering canopy reduces the wind far below the unsheltered bed value', () => {
    const open = windAdjustmentFactor(1.0, 0, 20, 0.5); // FM1 depth, no canopy
    const timber = windAdjustmentFactor(1.0, 200 / 255, 20, 0.5); // terrain-gen timber
    expect(open).toBeCloseTo(unshelteredWaf(1.0), 12);
    expect(timber).toBeLessThan(open * 0.5);
    expect(timber).toBeGreaterThan(0.05);
  });

  it('denser cover shelters more; a taller stand shelters more', () => {
    const a = windAdjustmentFactor(1.0, 0.4, 20, 0.5);
    const b = windAdjustmentFactor(1.0, 0.8, 20, 0.5);
    expect(b).toBeLessThan(a);
    const tall = windAdjustmentFactor(1.0, 0.8, 30, 0.5);
    expect(tall).toBeLessThan(b);
  });

  it('below the crown-fill threshold the bed is treated as unsheltered', () => {
    // Grass canopy byte 10 → cover 0.039 → f = 0.0065 ≪ 0.05.
    const f = crownFillPortion(10 / 255, 0.5);
    expect(f).toBeLessThan(SHELTER_THRESHOLD_FILL);
    expect(windAdjustmentFactor(1.0, 10 / 255, 20, 0.5)).toBeCloseTo(unshelteredWaf(1.0), 12);
  });
});

// ---------------------------------------------------------------------------

const FM = 1;
const MOIST_BYTE = 15;

function analyticR0Mps(): number {
  const bed = deadFuelBed(ANDERSON_13.get(FM)!, byteToFraction(MOIST_BYTE));
  return ftPerMinToMetersPerSec(surfaceSpread(bed, { midflameWind: 0, tanSlope: 0 }).rateOfSpread);
}

function planarWorld(canopyByte: number): WorldState {
  const cellSize = 40 * analyticR0Mps();
  const world = createWorld({ width: 60, height: 5, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST_BYTE);
  world.layers.canopy.data.fill(canopyByte);
  for (let y = 0; y < 5; y++) world.layers.fire.set(0, y, FireState.Burning);
  return world;
}

function frontColumn(world: WorldState): number {
  let front = 0;
  for (let x = 0; x < world.width; x++) {
    if (world.layers.fire.get(x, 2) !== FireState.Unburned) front = x;
  }
  return front;
}

describe("RothermelFireModel windReference: 'open'", () => {
  it("'open' wind W drives the front exactly as 'midflame' wind W·WAF does", () => {
    const W = 6; // m/s 20-ft open wind
    const waf = unshelteredWaf(ANDERSON_13.get(FM)!.depth);

    const open = planarWorld(0);
    new Simulation(open, [
      new UniformWeatherProvider(W, 0),
      new RothermelFireModel(new Anderson13FuelModel(), { windReference: 'open' }),
    ]).run(400, 1);

    const mid = planarWorld(0);
    new Simulation(mid, [
      new UniformWeatherProvider(W * waf, 0),
      new RothermelFireModel(new Anderson13FuelModel(), { windReference: 'midflame' }),
    ]).run(400, 1);

    expect(Array.from(open.layers.fire.data)).toEqual(Array.from(mid.layers.fire.data));
  });

  it("under 'open' the same reported wind moves a sheltered (timbered) front slower than an open one", () => {
    const W = 6;
    const bare = planarWorld(0);
    const sheltered = planarWorld(200);
    for (const w of [bare, sheltered]) {
      new Simulation(w, [
        new UniformWeatherProvider(W, 0),
        new RothermelFireModel(new Anderson13FuelModel(), { windReference: 'open' }),
      ]).run(400, 1);
    }
    expect(frontColumn(bare)).toBeGreaterThan(frontColumn(sheltered));
    expect(frontColumn(sheltered)).toBeGreaterThan(0); // still carries — sheltered, not stalled
  });

  it("the default reference is 'midflame' — behaviour is unchanged for existing callers", () => {
    const a = planarWorld(200);
    new Simulation(a, [
      new UniformWeatherProvider(3, 0),
      new RothermelFireModel(new Anderson13FuelModel()),
    ]).run(300, 1);
    const b = planarWorld(200);
    new Simulation(b, [
      new UniformWeatherProvider(3, 0),
      new RothermelFireModel(new Anderson13FuelModel(), { windReference: 'midflame' }),
    ]).run(300, 1);
    expect(Array.from(a.layers.fire.data)).toEqual(Array.from(b.layers.fire.data));
  });
});
