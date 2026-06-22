import { describe, it, expect } from 'vitest';
import {
  optimalPackingRatio,
  characteristicSAV,
  reactionVelocity,
  moistureDamping,
  mineralDamping,
  propagatingFluxRatio,
  effectiveHeatingNumber,
  heatOfPreignition,
  heatSink,
  windFactor,
  slopeFactor,
  flameResidenceTime,
  flameLength,
  meanBulkDensity,
  meanPackingRatio,
  netFuelLoad,
  reactionIntensity,
  ftPerMinToMetersPerSec,
  surfaceSpread,
  type FuelBed,
  type FuelParticle,
} from '../src/sim/rothermel';

const DEG = Math.PI / 180;

/**
 * Cross-checks against the published regression values in emxsys/behave's own
 * test suite (Bruce Schubert's port of Bevins' firelib v1.04 / BehavePlus). These
 * are an INDEPENDENT implementation's expected outputs, so matching them validates
 * our formulas rather than restating them.
 */
describe('Rothermel sub-functions vs emxsys/behave reference values', () => {
  it('optimalPackingRatio(1) = 3.348', () => {
    expect(optimalPackingRatio(1)).toBeCloseTo(3.348, 6);
  });

  it('reactionVelocity(0.3, 1) = 0.00033194651982916144', () => {
    expect(reactionVelocity(0.3, 1)).toBeCloseTo(0.00033194651982916144, 12);
  });

  it('propagatingFluxRatio(2, 3) matches the reference formula', () => {
    const expected = Math.exp((0.792 + 0.681 * Math.sqrt(2)) * (3 + 0.1)) / (192 + 0.2595 * 2);
    expect(propagatingFluxRatio(2, 3)).toBeCloseTo(expected, 10);
  });

  it('windFactor(2, 0.3, 0.4) = 13.551811735940076', () => {
    expect(windFactor(2, 0.3, 0.4)).toBeCloseTo(13.551811735940076, 8);
  });

  it('slopeFactor(tan 45°, 0.3) = 7.569829322728009', () => {
    expect(slopeFactor(Math.tan(45 * DEG), 0.3)).toBeCloseTo(7.569829322728009, 8);
  });

  it('flameLength(100 BTU/ft/s) = 3.74293696996202 ft', () => {
    expect(flameLength(100)).toBeCloseTo(3.74293696996202, 10);
  });

  it('flameResidenceTime(2) = 192 min', () => {
    expect(flameResidenceTime(2)).toBe(192);
  });

  it('heatOfPreignition(0.02 frac) = 272.32 BTU/lb', () => {
    expect(heatOfPreignition(0.02)).toBeCloseTo(272.32, 6);
  });

  it('effectiveHeatingNumber(2000) = exp(-0.069)', () => {
    expect(effectiveHeatingNumber(2000)).toBeCloseTo(Math.exp(-138 / 2000), 12);
  });
});

describe('moisture damping', () => {
  const mx = 0.12;
  it('is 1 for bone-dry fuel', () => {
    expect(moistureDamping(0, mx)).toBeCloseTo(1, 12);
  });
  it('falls to exactly 0 at the moisture of extinction', () => {
    expect(moistureDamping(mx, mx)).toBeCloseTo(0, 12);
  });
  it('stays clamped at 0 above the moisture of extinction', () => {
    expect(moistureDamping(2 * mx, mx)).toBeCloseTo(0, 12);
  });
  it('decreases monotonically from dry to extinction', () => {
    let prev = Infinity;
    for (let m = 0; m <= mx + 1e-9; m += mx / 10) {
      const d = moistureDamping(m, mx);
      expect(d).toBeLessThanOrEqual(prev + 1e-12);
      prev = d;
    }
  });
});

describe('mineral damping', () => {
  it('≈ 0.4174 for the standard effective mineral content (0.010)', () => {
    expect(mineralDamping()).toBeCloseTo(0.4174, 4);
  });
});

describe('characteristicSAV', () => {
  it('reduces to a single particle’s SAV', () => {
    expect(characteristicSAV([{ load: 0.5, sav: 3500, moisture: 0.06 }])).toBe(3500);
  });
  it('is surface-area weighted (fine fuel dominates)', () => {
    const fine: FuelParticle = { load: 0.1, sav: 3500, moisture: 0.06 };
    const coarse: FuelParticle = { load: 0.1, sav: 100, moisture: 0.06 };
    const sigma = characteristicSAV([fine, coarse]);
    // Equal loads → weighting by σ pulls the mean far above the arithmetic mean.
    expect(sigma).toBeGreaterThan((3500 + 100) / 2);
  });
});

/** A short-grass-like single-class fuel bed (Anderson FM1 ballpark). */
function grassBed(moisture: number): FuelBed {
  return {
    particles: [{ load: 0.034, sav: 3500, moisture }],
    depth: 1.0,
    moistureOfExtinction: 0.12,
    heatContent: 8000,
  };
}

describe('surfaceSpread assembly', () => {
  it('matches the model assembled directly from the primitives', () => {
    const bed = grassBed(0.06);
    const env = { midflameWind: 400, tanSlope: 0.2 };
    const p = bed.particles[0];

    // Hand-assemble R from the exported primitives (single-particle bed).
    const sigma = p.sav;
    const bulk = meanBulkDensity(p.load, bed.depth);
    const beta = meanPackingRatio(bulk);
    const betaRatio = beta / optimalPackingRatio(sigma);
    const ir = reactionIntensity(
      reactionVelocity(sigma, betaRatio),
      netFuelLoad(p.load),
      bed.heatContent,
      moistureDamping(p.moisture, bed.moistureOfExtinction),
      mineralDamping(),
    );
    const r0 = (ir * propagatingFluxRatio(sigma, beta)) / heatSink(bed.particles, bulk);
    const expected =
      r0 * (1 + windFactor(env.midflameWind, sigma, betaRatio) + slopeFactor(env.tanSlope, beta));

    const result = surfaceSpread(bed, env);
    expect(result.rateOfSpread).toBeCloseTo(expected, 8);
    expect(result.rateOfSpreadNoWindSlope).toBeCloseTo(r0, 8);
    expect(result.reactionIntensity).toBeCloseTo(ir, 6);
  });

  it('produces positive, finite fire behaviour for dry grass', () => {
    const r = surfaceSpread(grassBed(0.06), { midflameWind: 0, tanSlope: 0 });
    expect(r.rateOfSpread).toBeGreaterThan(0);
    expect(Number.isFinite(r.rateOfSpread)).toBe(true);
    expect(r.reactionIntensity).toBeGreaterThan(0);
    expect(r.firelineIntensity).toBeGreaterThan(0);
    expect(r.flameLength).toBeGreaterThan(0);
  });
});

describe('surfaceSpread physical behaviour', () => {
  it('wind increases the rate of spread', () => {
    const calm = surfaceSpread(grassBed(0.06), { midflameWind: 0, tanSlope: 0 });
    const windy = surfaceSpread(grassBed(0.06), { midflameWind: 800, tanSlope: 0 });
    expect(windy.rateOfSpread).toBeGreaterThan(calm.rateOfSpread);
  });

  it('upslope increases the rate of spread', () => {
    const flat = surfaceSpread(grassBed(0.06), { midflameWind: 0, tanSlope: 0 });
    const steep = surfaceSpread(grassBed(0.06), { midflameWind: 0, tanSlope: 0.5 });
    expect(steep.rateOfSpread).toBeGreaterThan(flat.rateOfSpread);
  });

  it('moisture slows the rate of spread', () => {
    const dry = surfaceSpread(grassBed(0.04), { midflameWind: 400, tanSlope: 0 });
    const damp = surfaceSpread(grassBed(0.1), { midflameWind: 400, tanSlope: 0 });
    expect(damp.rateOfSpread).toBeLessThan(dry.rateOfSpread);
    expect(damp.rateOfSpread).toBeGreaterThan(0);
  });

  it('does not spread at or above the moisture of extinction', () => {
    const out = surfaceSpread(grassBed(0.12), { midflameWind: 800, tanSlope: 0.5 });
    expect(out.rateOfSpread).toBe(0);
    expect(out.reactionIntensity).toBe(0);
    expect(out.flameLength).toBe(0);
  });

  it('returns zero for an empty or loadless bed', () => {
    const empty = surfaceSpread(
      { particles: [], depth: 1, moistureOfExtinction: 0.12, heatContent: 8000 },
      { midflameWind: 400, tanSlope: 0 },
    );
    expect(empty.rateOfSpread).toBe(0);
  });
});

describe('unit conversion', () => {
  it('converts ft/min to m/s', () => {
    // 100 ft/min = 30.48 m/min = 0.508 m/s
    expect(ftPerMinToMetersPerSec(100)).toBeCloseTo(0.508, 6);
  });
});
