import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel, ANDERSON_13, fuelBed } from '../src/sim/anderson13';
import {
  RothermelFireModel,
  type RothermelFireModelOptions,
} from '../src/sim/rothermelFireModel';
import {
  DEAD_MOISTURE,
  LIVE_MOISTURE,
  liveMoistureFromGreenness,
} from '../src/sim/moistureScenarios';
import { surfaceSpread, type SpreadEnv } from '../src/sim/rothermel';

/**
 * The standard moisture scenarios and the greenness curve drawn through them
 * (`src/sim/moistureScenarios.ts`). The tables are transcribed from BehavePlus
 * `moistureScenarios.cpp`; these pin the transcription and the curve that
 * interpolates it, then check the fire model actually plumbs it through.
 */

describe('standard moisture tables (BehavePlus moistureScenarios.cpp)', () => {
  it('has the four dead triples verbatim', () => {
    expect(DEAD_MOISTURE.veryLow).toEqual({ dead1h: 0.03, dead10h: 0.04, dead100h: 0.05 });
    expect(DEAD_MOISTURE.low).toEqual({ dead1h: 0.06, dead10h: 0.07, dead100h: 0.08 });
    expect(DEAD_MOISTURE.moderate).toEqual({ dead1h: 0.09, dead10h: 0.1, dead100h: 0.11 });
    expect(DEAD_MOISTURE.high).toEqual({ dead1h: 0.12, dead10h: 0.13, dead100h: 0.14 });
  });

  it('has the four live pairs verbatim, woody 30 points above herbaceous', () => {
    expect(LIVE_MOISTURE.fullyCured).toEqual({ liveHerb: 0.3, liveWoody: 0.6 });
    expect(LIVE_MOISTURE.twoThirdsCured).toEqual({ liveHerb: 0.6, liveWoody: 0.9 });
    expect(LIVE_MOISTURE.oneThirdCured).toEqual({ liveHerb: 0.9, liveWoody: 1.2 });
    expect(LIVE_MOISTURE.fullyGreen).toEqual({ liveHerb: 1.2, liveWoody: 1.5 });
    for (const p of Object.values(LIVE_MOISTURE)) {
      expect(p.liveWoody - p.liveHerb).toBeCloseTo(0.3, 12);
    }
  });
});

describe('the greenness curve', () => {
  it('reproduces all four standard rows exactly at 0, 1/3, 2/3 and 1', () => {
    const rows: Array<[number, keyof typeof LIVE_MOISTURE]> = [
      [0, 'fullyCured'],
      [1 / 3, 'twoThirdsCured'],
      [2 / 3, 'oneThirdCured'],
      [1, 'fullyGreen'],
    ];
    for (const [g, key] of rows) {
      const got = liveMoistureFromGreenness(g);
      expect(got.liveHerb, `herb at g=${g}`).toBeCloseTo(LIVE_MOISTURE[key].liveHerb, 12);
      expect(got.liveWoody, `woody at g=${g}`).toBeCloseTo(LIVE_MOISTURE[key].liveWoody, 12);
    }
  });

  it('clamps outside [0, 1] rather than extrapolating a line the source does not have', () => {
    expect(liveMoistureFromGreenness(-5)).toEqual(LIVE_MOISTURE.fullyCured);
    expect(liveMoistureFromGreenness(99)).toEqual(LIVE_MOISTURE.fullyGreen);
  });

  it('is monotonic — greener is always wetter in both classes', () => {
    let prev = liveMoistureFromGreenness(0);
    for (let g = 0.1; g <= 1.0001; g += 0.1) {
      const now = liveMoistureFromGreenness(g);
      expect(now.liveHerb).toBeGreaterThan(prev.liveHerb);
      expect(now.liveWoody).toBeGreaterThan(prev.liveWoody);
      prev = now;
    }
  });
});

describe('the curve reaching the fuel bed', () => {
  const CALM: SpreadEnv = { midflameWind: 0, tanSlope: 0 };
  // FM2 is the one Anderson model carrying live *herbaceous* fuel, so it is where
  // the herb column is observable; FM5 (brush) carries live woody only.
  const fm2 = ANDERSON_13.get(2)!;
  const fm5 = ANDERSON_13.get(5)!;

  it('puts the two live classes on different particles', () => {
    const { liveHerb, liveWoody } = liveMoistureFromGreenness(0.5);
    const bed = fuelBed(fm2, 0.06, 1.0, { liveHerb, liveWoody });
    const live = bed.particles.filter((p) => p.category === 'live');
    expect(live.map((p) => p.moisture)).toEqual([liveHerb]); // FM2 has no woody load
    expect(liveHerb).not.toBe(liveWoody);
  });

  it('makes a green bed spread slower than a cured one', () => {
    const r = (g: number, m = fm5): number => {
      const { liveHerb, liveWoody } = liveMoistureFromGreenness(g);
      return surfaceSpread(fuelBed(m, 0.06, 1.0, { liveHerb, liveWoody }), CALM)
        .rateOfSpreadNoWindSlope;
    };
    expect(r(0)).toBeGreaterThan(r(0.5));
    expect(r(0.5)).toBeGreaterThan(r(1));
    expect(r(0, fm2)).toBeGreaterThan(r(1, fm2));
  });
});

/**
 * A homogeneous flat windless field of a live-bearing fuel, left column alight —
 * the same planar-front harness `spread-ros.test.ts` uses, here just to prove the
 * fire model's options reach the bed.
 */
function planarFront(fuel: number, opts: RothermelFireModelOptions): WorldState {
  const world = createWorld({ width: 48, height: 12, seed: 1, cellSize: 10 });
  world.layers.fuel.data.fill(fuel);
  world.layers.moisture.data.fill(15); // ≈ 6% dead
  for (let y = 0; y < world.height; y++) world.layers.fire.set(0, y, FireState.Burning);
  const sim = new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel(), opts)]);
  sim.run(1800, 10);
  return world;
}

function touched(world: WorldState): number {
  let n = 0;
  for (const v of world.layers.fire.data) if (v !== FireState.Unburned) n++;
  return n;
}

describe('greenness on the fire model', () => {
  it('burns less of the map when the brush is green', () => {
    const cured = touched(planarFront(5, { greenness: 0 }));
    const green = touched(planarFront(5, { greenness: 1 }));
    expect(cured).toBeGreaterThan(green);
  });

  it('is byte-identical to the old single live-moisture form when unset', () => {
    // The whole back-compat guarantee in one assertion: every pinned test in the
    // repo predates the split and must keep passing.
    const a = planarFront(5, { liveMoisture: 0.8 });
    const b = planarFront(5, { liveMoisture: 0.8, greenness: undefined });
    expect(Array.from(b.layers.fire.data)).toEqual(Array.from(a.layers.fire.data));
  });

  it('lets an explicit per-class value override the curve', () => {
    // greenness 1 would put woody at 150%; forcing it back to the cured 60% must
    // reproduce the greenness-0 run for a woody-only fuel (FM5 has no herb load,
    // so the herb column the curve also set is inert here).
    const cured = planarFront(5, { greenness: 0 });
    const forced = planarFront(5, { greenness: 1, liveWoodyMoisture: 0.6 });
    expect(Array.from(forced.layers.fire.data)).toEqual(Array.from(cured.layers.fire.data));
  });
});
