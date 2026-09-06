import { describe, it, expect } from 'vitest';
import {
  ANDERSON_13,
  Anderson13FuelModel,
  deadFuelBed,
  fuelBed,
  hasLiveFuel,
  herbLoadTransferFraction,
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
  liveMoistureOfExtinction,
  characteristicSAV,
  type SpreadEnv,
} from '../src/sim/rothermel';

/** No wind, no slope — isolates R0 and the bed itself. */
const CALM: SpreadEnv = { midflameWind: 0, tanSlope: 0 };
/** A brisk midflame wind, for the intensity comparisons. */
const WINDY: SpreadEnv = { midflameWind: 300, tanSlope: 0 };

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

/**
 * Per-size-class dead-fuel moisture (Phase-2 plan §D6 item 1, landed in Phase 9).
 * The 10-hr and 100-hr classes can carry their own moisture instead of inheriting
 * the cell's fine (1-hr) value. Numbers below are **measured**, not assumed — see
 * `docs/science.md` §3a.
 */
describe('per-class dead moisture', () => {
  const uniform = (fm: number, m: number) =>
    surfaceSpread(deadFuelBed(ANDERSON_13.get(fm)!, m), CALM);
  const split = (fm: number, m1: number, m10: number, m100: number) =>
    surfaceSpread(
      deadFuelBed(ANDERSON_13.get(fm)!, m1, { dead10h: m10, dead100h: m100 }),
      CALM,
    );

  it('is a no-op when no coarse moisture is given — every pinned test depends on this', () => {
    for (let n = 1; n <= 13; n++) {
      const m = ANDERSON_13.get(n)!;
      expect(deadFuelBed(m, 0.07, {}), `FM${n}`).toEqual(deadFuelBed(m, 0.07));
      expect(deadFuelBed(m, 0.07, { dead10h: undefined }), `FM${n}`).toEqual(deadFuelBed(m, 0.07));
    }
  });

  it('puts each moisture on its own size class (FM10)', () => {
    const fm10 = ANDERSON_13.get(10)!;
    const bed = deadFuelBed(fm10, 0.06, { dead10h: 0.15, dead100h: 0.25 });
    expect(bed.particles).toEqual([
      { load: fm10.dead1hLoad, sav: fm10.dead1hSav, moisture: 0.06 },
      { load: fm10.dead10hLoad, sav: DEAD_10H_SAV, moisture: 0.15 },
      { load: fm10.dead100hLoad, sav: DEAD_100H_SAV, moisture: 0.25 },
    ]);
  });

  it('falls back per class, so a 100-hr value alone leaves the 10-hr class on the fine value', () => {
    const fm10 = ANDERSON_13.get(10)!;
    const bed = deadFuelBed(fm10, 0.06, { dead100h: 0.25 });
    expect(bed.particles.map((p) => p.moisture)).toEqual([0.06, 0.06, 0.25]);
  });

  it('cannot change a single-dead-class model — FM1 and FM3 have no coarse fuel', () => {
    for (const fm of [1, 3]) {
      expect(split(fm, 0.06, 0.15, 0.25).rateOfSpread, `FM${fm}`).toBe(
        uniform(fm, 0.06).rateOfSpread,
      );
    }
  });

  it('slows the fire monotonically as the coarse classes wet up (FM13)', () => {
    const dry = split(13, 0.06, 0.06, 0.06).rateOfSpreadNoWindSlope;
    const mid = split(13, 0.06, 0.1, 0.15).rateOfSpreadNoWindSlope;
    const wet = split(13, 0.06, 0.15, 0.25).rateOfSpreadNoWindSlope;
    expect(mid).toBeLessThan(dry);
    expect(wet).toBeLessThan(mid);
  });

  it('is a small effect on R0, concentrated in the heavy multi-class beds (measured)', () => {
    // Ratio of R0 at 1-hr 6% / 10-hr 15% / 100-hr 25% to a uniform 6%.
    const ratio = (fm: number) =>
      split(fm, 0.06, 0.15, 0.25).rateOfSpreadNoWindSlope /
      uniform(fm, 0.06).rateOfSpreadNoWindSlope;
    expect(ratio(13)).toBeCloseTo(0.8905, 3); // heavy slash: the most it moves
    expect(ratio(12)).toBeCloseTo(0.9128, 3);
    expect(ratio(6)).toBeCloseTo(0.9417, 3);
    expect(ratio(10)).toBeCloseTo(0.964, 3); // the timber bed that drives crown fire
    expect(ratio(9)).toBeCloseTo(0.9962, 3); // long-needle litter: nearly nothing
  });

  it('moves fireline intensity about twice as far as spread rate (FM13, measured)', () => {
    // Intensity is what crown fire and ember production threshold on, so the
    // bigger lever there is the point of the feature.
    const a = surfaceSpread(deadFuelBed(ANDERSON_13.get(13)!, 0.06), WINDY);
    const b = surfaceSpread(
      deadFuelBed(ANDERSON_13.get(13)!, 0.06, { dead10h: 0.15, dead100h: 0.25 }),
      WINDY,
    );
    expect(b.rateOfSpread / a.rateOfSpread).toBeCloseTo(0.8905, 3);
    expect(b.firelineIntensity / a.firelineIntensity).toBeCloseTo(0.8108, 3);
  });

  it('feeds the live moisture of extinction, which weights dead moisture by fineness', () => {
    // Albini's M_x,live reads a fineness-weighted *dead* moisture, so splitting the
    // classes changes it. It needs the two-category bed — on a dead-only bed there
    // is no live fuel and the function short-circuits to the dead M_x.
    const fm10 = ANDERSON_13.get(10)!;
    const flat = liveMoistureOfExtinction(fuelBed(fm10, 0.06, 1.0));
    const wetCoarse = liveMoistureOfExtinction(
      fuelBed(fm10, 0.06, 1.0, { dead10h: 0.15, dead100h: 0.25 }),
    );
    // Wetter coarse dead fuel raises the fineness-weighted dead moisture, so the
    // dead component preheats the live fuel less well: M_x,live falls.
    expect(flat).toBeGreaterThan(fm10.deadMx);
    expect(wetCoarse).toBeLessThan(flat);
  });
});

/**
 * Dynamic herbaceous **load transfer** (`herbLoadTransferFraction` plus the
 * `herbLoadTransfer` bed option) — curing's other half, transcribed from
 * BehavePlus `surfaceFuelbedIntermediates.cpp`, `dynamicLoadTransfer()`.
 */
describe('herbaceous load transfer (BehavePlus dynamicLoadTransfer)', () => {
  it('reproduces the shipped fraction, residue and all', () => {
    // if (M < 0.30) all of it; else if (M <= 1.20) 1.333 - 1.11*M; else none.
    expect(herbLoadTransferFraction(0.1)).toBe(1);
    expect(herbLoadTransferFraction(0.29)).toBe(1);
    expect(herbLoadTransferFraction(0.3)).toBeCloseTo(1.0, 6); // 1.333 - 0.333
    expect(herbLoadTransferFraction(0.75)).toBeCloseTo(0.5005, 6);
    expect(herbLoadTransferFraction(1.5)).toBe(0);
    // BehavePlus ships `1.333 - 1.11*M` with the exact `(1.20 - M)/0.9` commented
    // out beside it, so fully green leaves a 0.1% residue rather than zero. Pinned
    // deliberately: we reproduce the reference, we do not quietly correct it.
    expect(herbLoadTransferFraction(1.2)).toBeCloseTo(0.001, 9);
  });

  it('is the greenness curve read backwards: f = 1 - g', () => {
    // liveHerb = 0.30 + 0.90*g, so 1.333 - 1.11*(0.30 + 0.90*g) = 1.0 - 0.999*g.
    // BehavePlus derives the transfer from live herbaceous moisture, and the
    // season knob sets that moisture — so one knob drives both halves of curing.
    for (const g of [0, 0.25, 0.5, 0.75, 1]) {
      expect(herbLoadTransferFraction(0.3 + 0.9 * g)).toBeCloseTo(1 - g, 2);
    }
  });

  it('moves load into a fourth dead class at the live-herb SAV and the fine moisture', () => {
    // BehavePlus loadDead_[3] / savrDead_[3] / moistureDead_[3].
    const fm2 = ANDERSON_13.get(2)!;
    const bed = fuelBed(fm2, 0.06, 1.0, { liveHerb: 0.3, herbLoadTransfer: 1 });
    const transferred = bed.particles.filter((q) => q.sav === fm2.liveHerbSav);
    expect(transferred).toHaveLength(1);
    expect(transferred[0].load).toBeCloseTo(fm2.liveHerbLoad, 12);
    expect(transferred[0].moisture).toBe(0.06); // the FINE dead moisture, not the live one
    expect(transferred[0].category).toBeUndefined(); // dead
    // FM2 carries no live woody, so at full transfer the bed loses its live
    // category outright rather than keeping a zero-load particle.
    expect(bed.particles.some((q) => q.category === 'live')).toBe(false);
    expect(bed.particles).toHaveLength(4);
  });

  it('halves cleanly: what leaves the live side is exactly what arrives dead', () => {
    const fm2 = ANDERSON_13.get(2)!;
    const bed = fuelBed(fm2, 0.06, 0.75, { liveHerb: 0.75, herbLoadTransfer: 0.5 });
    const live = bed.particles.filter((q) => q.category === 'live');
    const dead = bed.particles.filter((q) => q.category !== 'live');
    expect(live).toHaveLength(1);
    expect(live[0].load).toBeCloseTo(fm2.liveHerbLoad * 0.5, 12);
    expect(dead).toHaveLength(4);
    expect(dead[3].load).toBeCloseTo(fm2.liveHerbLoad * 0.5, 12);
  });

  it('is inert for the twelve models with no live herbaceous load', () => {
    // Only FM2 carries one in the Anderson catalogue — the transfer is a
    // dynamic-model mechanic and the standard 13 are static (`docs/science.md` §9).
    for (const [n, m] of ANDERSON_13) {
      if (n === 2) continue;
      expect(m.liveHerbLoad).toBe(0);
      expect(fuelBed(m, 0.07, 1.0, { herbLoadTransfer: 1 })).toEqual(fuelBed(m, 0.07, 1.0));
    }
  });

  it('omitting it reproduces the untransferred bed byte-for-byte, all 13 models', () => {
    for (const [, m] of ANDERSON_13) {
      expect(fuelBed(m, 0.0731, 0.83, { herbLoadTransfer: 0 })).toEqual(fuelBed(m, 0.0731, 0.83));
      expect(deadFuelBed(m, 0.0731, { herbLoadTransfer: 0 })).toEqual(deadFuelBed(m, 0.0731));
    }
  });

  it('stays finite everywhere, including the bed that loses its live category', () => {
    for (const [, m] of ANDERSON_13) {
      for (const f of [0, 0.5, 1]) {
        const r = surfaceSpread(fuelBed(m, 0.06, 1.0, { herbLoadTransfer: f }), WINDY);
        for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('LOWERS FM2 spread and intensity when fully cured — extinction moisture is why (measured)', () => {
    // The intuition ("dead fine fuel carries fire, so curing must help") is wrong
    // for FM2, and the reason is worth pinning. Moving the class changes neither
    // the bed's total load, nor its depth, packing ratio or characteristic SAV —
    // only which category the load is damped in. FM2's *dead* moisture of
    // extinction is 15%, while its live one comes out around 1044%, so the same
    // grass is damped 0.56 as dead fuel at 6% and 0.93 as live fuel at 30%.
    const fm2 = ANDERSON_13.get(2)!;
    const cured = { liveHerb: 0.3, liveWoody: 0.6 };
    const a = surfaceSpread(fuelBed(fm2, 0.06, 1.0, cured), CALM);
    const b = surfaceSpread(fuelBed(fm2, 0.06, 1.0, { ...cured, herbLoadTransfer: 1 }), CALM);
    expect(b.rateOfSpreadNoWindSlope / a.rateOfSpreadNoWindSlope).toBeCloseTo(0.957, 3);
    expect(b.firelineIntensity / a.firelineIntensity).toBeCloseTo(0.841, 3);
    expect(moistureDamping(0.06, fm2.deadMx)).toBeCloseTo(0.5563, 4);
    expect(liveMoistureOfExtinction(fuelBed(fm2, 0.06, 1.0, cured))).toBeCloseTo(10.4445, 3);
  });

  it('is a smaller lever than the season moisture it rides on (FM2, measured)', () => {
    // Green -> cured moves R0 x1.38 on moisture alone; the transfer takes that to
    // x1.32. So for the Anderson catalogue the load half is the *minor* one and it
    // pulls the other way — the opposite of what it does in the Scott & Burgan
    // dynamic models, where herbaceous load is a much bigger share of the bed.
    const fm2 = ANDERSON_13.get(2)!;
    const at = (g: number, dyn: boolean): number =>
      surfaceSpread(
        fuelBed(fm2, 0.06, 1.0, {
          liveHerb: 0.3 + 0.9 * g,
          liveWoody: 0.6 + 0.9 * g,
          herbLoadTransfer: dyn ? herbLoadTransferFraction(0.3 + 0.9 * g) : 0,
        }),
        CALM,
      ).rateOfSpreadNoWindSlope;
    expect(at(0, false) / at(1, false)).toBeCloseTo(1.3815, 3);
    expect(at(0, true) / at(1, true)).toBeCloseTo(1.3219, 3);
  });

  it('coarsens the dead bed, so cured fuel also burns for longer', () => {
    // The transferred class arrives at SAV 1500 against FM2's fine 3000, so the
    // dead characteristic SAV falls and Albini's residence time 384/sigma rises.
    // `deadFuelBed` takes the transfer for exactly this reason: one fuel, one dead
    // bed, whether the caller wants spread or burnout.
    const fm2 = ANDERSON_13.get(2)!;
    const plain = characteristicSAV(deadFuelBed(fm2, 0).particles);
    const cured = characteristicSAV(deadFuelBed(fm2, 0, { herbLoadTransfer: 1 }).particles);
    expect(plain).toBeCloseTo(2941.3, 1);
    expect(cured).toBeCloseTo(2784.0, 1);
    expect(384 / cured / (384 / plain)).toBeCloseTo(1.0565, 3);
  });
});
