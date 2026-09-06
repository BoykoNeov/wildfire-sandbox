import { describe, expect, it } from 'vitest';
import { ANDERSON_13, deadFuelBed, fuelBed, hasLiveFuel, herbLoadTransferFraction } from '../src/sim/anderson13';
import { liveMoistureFromGreenness } from '../src/sim/moistureScenarios';
import { surfaceSpread, type SpreadEnv } from '../src/sim/rothermel';
import {
  SCOTT_BURGAN_40,
  STANDARD_FUEL_MODELS,
  ScottBurgan40FuelModel,
  StandardFuelModel,
  TONS_PER_ACRE_TO_LB_PER_FT2,
} from '../src/sim/scottBurgan40';
import fixture from './fixtures/sb40-fuelModels.json';

/**
 * The transcription pin. `tests/fixtures/sb40-fuelModels.json` is generated from
 * BehavePlus' `fuelModels.cpp` by `tools/sb40Fixture.mjs`, NOT retyped — a test
 * that restated the same literals as `scottBurgan40.ts` would repeat whatever slip
 * the transcription made. Loads are compared in the source's own tons/acre, so the
 * unit conversion is checked on our side rather than baked into the expectation.
 */
describe('Scott & Burgan 40 — transcription against the BehavePlus source', () => {
  const T = TONS_PER_ACRE_TO_LB_PER_FT2;

  it('has all 40 standard models and no others', () => {
    expect(SCOTT_BURGAN_40.size).toBe(40);
    expect([...SCOTT_BURGAN_40.keys()]).toEqual(fixture.models.map((m) => m.number));
  });

  it.each(fixture.models)('$code ($number) matches the source row', (f) => {
    const m = SCOTT_BURGAN_40.get(f.number)!;
    expect(m.code).toBe(f.code);
    expect(m.name).toBe(f.name);
    expect(m.depth).toBe(f.depth);
    expect(m.deadMx).toBe(f.deadMx);
    expect(m.heatContent).toBe(f.heatDead);
    expect(m.dead1hSav).toBe(f.dead1hSav);
    expect(m.liveHerbSav).toBe(f.liveHerbSav);
    expect(m.liveWoodySav).toBe(f.liveWoodySav);
    expect(m.dynamic).toBe(f.dynamic);
    // Loads: ours are lb/ft², the source's are tons/acre × f.
    expect(m.dead1hLoad).toBeCloseTo(f.dead1hLoadTonsPerAcre * T, 12);
    expect(m.dead10hLoad).toBeCloseTo(f.dead10hLoadTonsPerAcre * T, 12);
    expect(m.dead100hLoad).toBeCloseTo(f.dead100hLoadTonsPerAcre * T, 12);
    expect(m.liveHerbLoad).toBeCloseTo(f.liveHerbLoadTonsPerAcre * T, 12);
    expect(m.liveWoodyLoad).toBeCloseTo(f.liveWoodyLoadTonsPerAcre * T, 12);
  });

  it('every standard model uses one heat content for both categories', () => {
    // This is what makes `FuelBed.heatContent` (a single field) honest. The
    // regional and international models BehavePlus also ships do NOT all satisfy
    // it, which is why they are out of scope — see the module header.
    for (const f of fixture.models) expect(f.heatLive, f.code).toBe(f.heatDead);
  });

  it('flags exactly the 17 dynamic models', () => {
    const dynamic = [...SCOTT_BURGAN_40.values()].filter((m) => m.dynamic).map((m) => m.code);
    expect(dynamic).toEqual([
      'GR1', 'GR2', 'GR3', 'GR4', 'GR5', 'GR6', 'GR7', 'GR8', 'GR9',
      'GS1', 'GS2', 'GS3', 'GS4',
      'SH1', 'SH9',
      'TU1', 'TU3',
    ]);
  });

  it('records the source revision the fixture was generated from', () => {
    expect(fixture.revision).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('Scott & Burgan 40 — catalogue shape', () => {
  it('is exactly the models that carry live herbaceous load that are dynamic', () => {
    // BehavePlus' transfer moves live HERBACEOUS load, so a dynamic model with no
    // herbaceous load would be a flag with nothing to act on, and a static model
    // with herbaceous load would be a lever deliberately withheld. Neither occurs.
    for (const m of SCOTT_BURGAN_40.values()) {
      expect(m.dynamic, m.code).toBe(m.liveHerbLoad > 0);
    }
  });

  it('spans a far wider load range than the Anderson 13 grass models', () => {
    const load = (m: { dead1hLoad: number; dead10hLoad: number; dead100hLoad: number; liveHerbLoad: number; liveWoodyLoad: number }) =>
      m.dead1hLoad + m.dead10hLoad + m.dead100hLoad + m.liveHerbLoad + m.liveWoodyLoad;
    const gr1 = load(SCOTT_BURGAN_40.get(101)!);
    const gr9 = load(SCOTT_BURGAN_40.get(109)!);
    expect(gr9 / gr1).toBeGreaterThan(20);
    // FM1/FM3, the two Anderson grass models, span barely 4×.
    expect(load(ANDERSON_13.get(3)!) / load(ANDERSON_13.get(1)!)).toBeLessThan(5);
  });

  it('grass models are mostly LIVE load, which is the point of the catalogue', () => {
    // The Anderson FM2 is 1 part live herbaceous to 7 dead; GR2 is 10 to 1 the
    // other way. That inversion is why curing barely moved FM2 (science.md §3c)
    // and should move these — see the "curing" tests below.
    const fm2 = ANDERSON_13.get(2)!;
    expect(fm2.liveHerbLoad / (fm2.dead1hLoad + fm2.dead10hLoad + fm2.dead100hLoad)).toBeCloseTo(0.143, 2);
    const gr2 = SCOTT_BURGAN_40.get(102)!;
    expect(gr2.liveHerbLoad / gr2.dead1hLoad).toBeCloseTo(10, 6);
  });
});

describe('the standard-catalogue union', () => {
  it('holds both catalogues with no id collision', () => {
    expect(STANDARD_FUEL_MODELS.size).toBe(ANDERSON_13.size + SCOTT_BURGAN_40.size);
    expect(STANDARD_FUEL_MODELS.get(2)!.code).toBe('FM2');
    expect(STANDARD_FUEL_MODELS.get(102)!.code).toBe('GR2');
  });

  it('serves Anderson params identically through either fuel model', () => {
    const standard = new StandardFuelModel();
    for (const n of ANDERSON_13.keys()) {
      expect(standard.getParams(n).rothermel, `FM${n}`).toEqual({
        ...ANDERSON_13.get(n)!,
        number: undefined,
        code: undefined,
        name: undefined,
        dynamic: false,
      } as never);
    }
  });

  it('treats id 0 and unknown ids as nonburnable', () => {
    for (const model of [new StandardFuelModel(), new ScottBurgan40FuelModel()]) {
      for (const id of [0, 99, 205, 999]) {
        expect(model.getParams(id).burnable, `id ${id}`).toBe(false);
      }
    }
    // The narrow model does not serve the Anderson numbers.
    expect(new ScottBurgan40FuelModel().getParams(1).burnable).toBe(false);
    expect(new StandardFuelModel().getParams(1).burnable).toBe(true);
  });

  it('returns the same FuelParams object every call (the hot-loop cache)', () => {
    const model = new StandardFuelModel();
    expect(model.getParams(102)).toBe(model.getParams(102));
    expect(model.getParams(0)).toBe(model.getParams(0));
  });

  it('carries the dynamic flag through the seam', () => {
    const model = new StandardFuelModel();
    expect(model.getParams(102).rothermel!.dynamic).toBe(true); // GR2
    expect(model.getParams(182).rothermel!.dynamic).toBe(false); // TL2
    expect(model.getParams(2).rothermel!.dynamic).toBe(false); // FM2, static
  });
});

describe('bed assembly for the new catalogue', () => {
  it('a fully cured grass model has NO live category left', () => {
    // GR2 is live-herbaceous only: transfer all of it and the bed loses its live
    // category outright, the same path `fuelBed` already takes for a cured FM2.
    const gr2 = SCOTT_BURGAN_40.get(102)!;
    expect(hasLiveFuel(gr2)).toBe(true);
    const cured = fuelBed(gr2, 0.06, 0.3, { liveHerb: 0.3, herbLoadTransfer: 1 });
    expect(cured.particles.every((p) => p.category !== 'live')).toBe(true);
    // The cured load arrives as a fourth dead class at the LIVE herbaceous SAV.
    expect(cured.particles.map((p) => p.sav).sort((a, b) => a - b)).toEqual([1800, 2000]);
    expect(cured.particles.find((p) => p.sav === 1800)!.load).toBeCloseTo(gr2.liveHerbLoad, 12);
  });

  it('a cured grass-shrub model keeps its live WOODY class', () => {
    const gs2 = SCOTT_BURGAN_40.get(122)!;
    const cured = fuelBed(gs2, 0.06, 0.3, { liveHerb: 0.3, herbLoadTransfer: 1 });
    const live = cured.particles.filter((p) => p.category === 'live');
    expect(live).toHaveLength(1);
    expect(live[0]!.load).toBeCloseTo(gs2.liveWoodyLoad, 12);
  });

  it('static models are inert under a transfer, exactly as before', () => {
    for (const m of SCOTT_BURGAN_40.values()) {
      if (m.dynamic) continue;
      expect(fuelBed(m, 0.07, 1.0, { herbLoadTransfer: 1 }), m.code).toEqual(fuelBed(m, 0.07, 1.0));
      expect(deadFuelBed(m, 0.07, { herbLoadTransfer: 1 }), m.code).toEqual(deadFuelBed(m, 0.07));
    }
  });
});

/**
 * The claim this phase exists to test. `docs/science.md` §3c used to end by
 * predicting that curing, a minor and *backwards* lever in the Anderson 13, would
 * be a large one here. Phase 9b measured its own prediction into a retraction, so
 * this one gets pinned rather than asserted in prose.
 */
describe('the curing lever, measured', () => {
  const WINDY: SpreadEnv = { midflameWind: 350, tanSlope: 0 };
  const DEAD = 0.06;

  /** A bed at a given season, with the transfer following the catalogue or forced. */
  function behaviour(m: Parameters<typeof fuelBed>[0], greenness: number, transferOn: boolean) {
    const live = liveMoistureFromGreenness(greenness);
    const bed = fuelBed(m, DEAD, 1.0, {
      dead10h: 0.08,
      dead100h: 0.09,
      liveHerb: live.liveHerb,
      liveWoody: live.liveWoody,
      herbLoadTransfer: transferOn ? herbLoadTransferFraction(live.liveHerb) : 0,
    });
    return surfaceSpread(bed, WINDY);
  }

  const ratio = (n: number, greenness = 0, transferOn = true) => {
    const m = SCOTT_BURGAN_40.get(n)!;
    const green = behaviour(m, 1, true);
    const cured = behaviour(m, greenness, transferOn);
    return {
      ros: cured.rateOfSpreadNoWindSlope / green.rateOfSpreadNoWindSlope,
      intensity: cured.firelineIntensity / green.firelineIntensity,
    };
  };

  it('green to cured is a LARGE lever on the grass models', () => {
    // Measured green→cured (both halves), R₀ and fireline intensity:
    //   GR2 ×50.2 / ×546   GR4 ×38.4 / ×327   GS2 ×10.4 / ×45.5
    //   TU1 ×7.10 / ×22.8  TU3 ×3.02 / ×4.15
    // Against Anderson FM2's ×1.32 / ×1.23 — one to two orders of magnitude more.
    expect(ratio(102).ros).toBeCloseTo(50.2, 0); // GR2
    expect(ratio(102).intensity).toBeCloseTo(546, -1);
    expect(ratio(104).ros).toBeCloseTo(38.4, 0); // GR4
    expect(ratio(122).ros).toBeCloseTo(10.4, 1); // GS2
    expect(ratio(161).ros).toBeCloseTo(7.10, 1); // TU1
    expect(ratio(163).ros).toBeCloseTo(3.02, 1); // TU3
  });

  it('and it runs the RIGHT way, unlike FM2', () => {
    // Every model that carries herbaceous load burns harder cured than green.
    for (const m of SCOTT_BURGAN_40.values()) {
      if (!m.dynamic) continue;
      const r = ratio(m.number);
      expect(r.ros, m.code).toBeGreaterThan(1);
      expect(r.intensity, m.code).toBeGreaterThan(1);
    }
  });

  it('the LOAD half is the dominant one here — the opposite of the Anderson 13', () => {
    // Transfer on vs off, both fully cured. In the Anderson catalogue this factor
    // is 0.958 on FM2 (it makes the fire *smaller*); on the grass models it is
    // 15–19× on R₀, because their bed is mostly herbaceous load and leaving it in
    // the live category damps it against a live M_x that a 30 % moisture exceeds.
    const half = (n: number) => {
      const m = SCOTT_BURGAN_40.get(n)!;
      return behaviour(m, 0, true).rateOfSpreadNoWindSlope / behaviour(m, 0, false).rateOfSpreadNoWindSlope;
    };
    expect(half(102)).toBeCloseTo(19.4, 0); // GR2
    expect(half(104)).toBeCloseTo(14.9, 0); // GR4
    expect(half(122)).toBeCloseTo(1.54, 1); // GS2 — herbaceous is a smaller share
    expect(half(161)).toBeCloseTo(1.06, 1); // TU1 — smaller still
  });

  it('but it still flips sign where the herbaceous share is small', () => {
    // SH9 carries 1.55 of 15.5 tons/acre as live herbaceous and has a dead M_x of
    // 40 %, so moving that load to the dead side damps it HARDER — the same
    // mechanism that makes FM2 burn less (science.md §3c). The direction of this
    // half is a property of the model, not of the catalogue.
    const sh9 = SCOTT_BURGAN_40.get(149)!;
    const on = behaviour(sh9, 0, true);
    const off = behaviour(sh9, 0, false);
    expect(on.rateOfSpreadNoWindSlope / off.rateOfSpreadNoWindSlope).toBeCloseTo(0.895, 2);
    expect(on.firelineIntensity / off.firelineIntensity).toBeCloseTo(0.751, 2);
  });

  it('a fully green grass landscape does not carry fire at all', () => {
    // R₀ under 0.15 ft/min is under 5 cm/min: an ignition that dies. Measured on
    // the map, greenness ≥ 0.8 puts the whole run out inside five cells, which is
    // why the season pair's green member sits at 0.6 and not 1 (`presets.ts`).
    for (const n of [101, 102, 104, 105, 106]) {
      const m = SCOTT_BURGAN_40.get(n)!;
      expect(behaviour(m, 1, true).rateOfSpreadNoWindSlope, m.code).toBeLessThan(0.15);
    }
  });

  it('without the transfer, a dynamic grass model is unusable at ANY season', () => {
    // The strongest form of the finding: for GR2 the transfer is not an
    // enhancement, it is a precondition. Cured to 30 % herbaceous moisture but
    // left in the live category, the load is still damped against a live moisture
    // of extinction it exceeds, so 90 % of the bed contributes nothing.
    const gr2 = SCOTT_BURGAN_40.get(102)!;
    for (const g of [1, 0.5, 0]) {
      expect(behaviour(gr2, g, false).rateOfSpreadNoWindSlope, `greenness ${g}`).toBeLessThan(0.2);
    }
    expect(behaviour(gr2, 0, true).rateOfSpreadNoWindSlope).toBeGreaterThan(2);
  });
});
