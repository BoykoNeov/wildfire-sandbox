import { describe, it, expect } from 'vitest';
import {
  ANDERSON_13,
  Anderson13FuelModel,
  deadFuelBed,
  hasLiveFuel,
  DEAD_10H_SAV,
  DEAD_100H_SAV,
} from '../src/sim/anderson13';
import {
  surfaceSpread,
  reactionIntensity,
  reactionVelocity,
  netFuelLoad,
  moistureDamping,
  mineralDamping,
  meanBulkDensity,
  meanPackingRatio,
  optimalPackingRatio,
} from '../src/sim/rothermel';

/**
 * The catalogue parameters are transcribed from the USFS Fire Lab BehavePlus
 * source (`firelab/behave`, `fuelModels.cpp`). These spot-checks pin a few rows
 * to that source so a transcription slip can't pass silently.
 */
describe('Anderson 13 catalogue integrity', () => {
  it('has all 13 standard models, numbered 1–13 with FMx codes', () => {
    expect(ANDERSON_13.size).toBe(13);
    for (let n = 1; n <= 13; n++) {
      const m = ANDERSON_13.get(n)!;
      expect(m.number).toBe(n);
      expect(m.code).toBe(`FM${n}`);
      expect(m.heatContent).toBe(8000);
    }
  });

  it('matches the source values for representative rows', () => {
    const fm1 = ANDERSON_13.get(1)!;
    expect(fm1.dead1hLoad).toBe(0.034);
    expect(fm1.dead1hSav).toBe(3500);
    expect(fm1.depth).toBe(1.0);
    expect(fm1.deadMx).toBe(0.12);

    const fm4 = ANDERSON_13.get(4)!; // chaparral — deep, live-woody
    expect(fm4.depth).toBe(6.0);
    expect(fm4.liveWoodyLoad).toBe(0.23);

    const fm13 = ANDERSON_13.get(13)!; // heavy slash — heaviest 100-hr load
    expect(fm13.dead100hLoad).toBe(1.288);
    expect(fm13.dead10hLoad).toBe(1.058);
  });

  it('flags exactly the five live-bearing models as having live fuel', () => {
    const live = [...ANDERSON_13.values()].filter(hasLiveFuel).map((m) => m.number);
    expect(live.sort((a, b) => a - b)).toEqual([2, 4, 5, 7, 10]);
  });
});

describe('Anderson13FuelModel.getParams contract', () => {
  const model = new Anderson13FuelModel();

  it('returns nonburnable for id 0 and unknown ids', () => {
    for (const id of [0, 14, 99, -1]) {
      const p = model.getParams(id);
      expect(p.burnable).toBe(false);
      expect(p.rothermel).toBeUndefined();
    }
  });

  it('returns a burnable, rothermel-bearing record for 1–13', () => {
    for (let n = 1; n <= 13; n++) {
      const p = model.getParams(n);
      expect(p.burnable).toBe(true);
      expect(p.rothermel).toBeDefined();
      expect(p.rothermel!.depth).toBe(ANDERSON_13.get(n)!.depth);
    }
  });
});

describe('deadFuelBed assembly', () => {
  it('builds a single particle for a dead-only single-class model (FM1)', () => {
    const bed = deadFuelBed(ANDERSON_13.get(1)!, 0.06);
    expect(bed.particles).toEqual([{ load: 0.034, sav: 3500, moisture: 0.06 }]);
    expect(bed.depth).toBe(1.0);
    expect(bed.moistureOfExtinction).toBe(0.12);
    expect(bed.heatContent).toBe(8000);
  });

  it('uses the standard 10-/100-hr SAVs and drops live + zero-load classes (FM10)', () => {
    const fm10 = ANDERSON_13.get(10)!; // 1h/10h/100h dead + live woody
    const bed = deadFuelBed(fm10, 0.08);
    // Three dead classes, live woody dropped.
    expect(bed.particles).toEqual([
      { load: fm10.dead1hLoad, sav: fm10.dead1hSav, moisture: 0.08 },
      { load: fm10.dead10hLoad, sav: DEAD_10H_SAV, moisture: 0.08 },
      { load: fm10.dead100hLoad, sav: DEAD_100H_SAV, moisture: 0.08 },
    ]);
  });

  it('omits a zero-load size class (FM5 has no 100-hr load)', () => {
    const fm5 = ANDERSON_13.get(5)!; // 1h + 10h dead, 100h = 0, live woody
    const bed = deadFuelBed(fm5, 0.06);
    expect(bed.particles.map((p) => p.sav)).toEqual([fm5.dead1hSav, DEAD_10H_SAV]);
  });
});

describe('FM1 end-to-end path (catalogue → Rothermel)', () => {
  it('produces positive, finite fire behaviour for dry short grass', () => {
    const bed = deadFuelBed(ANDERSON_13.get(1)!, 0.06);
    const r = surfaceSpread(bed, { midflameWind: 400, tanSlope: 0 });
    expect(r.rateOfSpread).toBeGreaterThan(0);
    expect(Number.isFinite(r.rateOfSpread)).toBe(true);
    expect(r.flameLength).toBeGreaterThan(0);
  });

  it('does not spread at or above the dead moisture of extinction (12%)', () => {
    const bed = deadFuelBed(ANDERSON_13.get(1)!, 0.12);
    expect(surfaceSpread(bed, { midflameWind: 800, tanSlope: 0.3 }).rateOfSpread).toBe(0);
  });

  it('exercises the confirmed net-load convention w_n = w0·(1−S_T)', () => {
    // FM1 is single-class, so the single-category model is exact here and the
    // reaction intensity must use net load w0·(1−S_T). Re-derive it from the
    // primitives and require the assembled model to agree.
    const m = ANDERSON_13.get(1)!;
    const bed = deadFuelBed(m, 0.06);
    const sigma = m.dead1hSav;
    const beta = meanPackingRatio(meanBulkDensity(m.dead1hLoad, m.depth));
    const betaRatio = beta / optimalPackingRatio(sigma);
    const ir = reactionIntensity(
      reactionVelocity(sigma, betaRatio),
      netFuelLoad(m.dead1hLoad),
      m.heatContent,
      moistureDamping(0.06, m.deadMx),
      mineralDamping(),
    );
    expect(surfaceSpread(bed, { midflameWind: 0, tanSlope: 0 }).reactionIntensity).toBeCloseTo(
      ir,
      6,
    );
  });
});

describe('cross-model physical sanity', () => {
  it('tall grass (FM3) spreads faster than short grass (FM1) at equal conditions', () => {
    const env = { midflameWind: 400, tanSlope: 0 };
    const fm1 = surfaceSpread(deadFuelBed(ANDERSON_13.get(1)!, 0.06), env);
    const fm3 = surfaceSpread(deadFuelBed(ANDERSON_13.get(3)!, 0.06), env);
    expect(fm3.rateOfSpread).toBeGreaterThan(fm1.rateOfSpread);
    expect(fm1.rateOfSpread).toBeGreaterThan(0);
  });

  it('every burnable model carries fire when dry with wind', () => {
    for (let n = 1; n <= 13; n++) {
      const bed = deadFuelBed(ANDERSON_13.get(n)!, 0.05);
      const r = surfaceSpread(bed, { midflameWind: 400, tanSlope: 0 });
      expect(r.rateOfSpread, `FM${n} should carry fire`).toBeGreaterThan(0);
    }
  });
});
