import { describe, it, expect } from 'vitest';
import {
  firebrandDrift,
  firebrandHeightFromSurfaceFire,
  maxSpotDistanceM,
  spotCriticalCoverHeight,
  spotDistanceFlatTerrain,
  thermalEnergyFactor,
} from '../src/sim/spotDistance';

/**
 * Pins Albini's surface-fire spotting distance (`src/sim/spotDistance.ts`) against
 * an **independent** evaluation of BehavePlus' `src/behave/spot.cpp`: the C++ was
 * transcribed separately into a scratch reference and the literals below are its
 * output, so a shared bug would have to be made twice, in two languages, to slip
 * through. Every value is in Albini's native units except where a name says
 * otherwise (feet, mi/h, miles) — that is what the C++ works in, and pinning the
 * sub-functions there keeps the unit conversions in {@link maxSpotDistanceM}
 * separately falsifiable.
 */

const REL = 1e-9;

/** Assert `got` matches `want` to a relative tolerance (values span 1e-2..1e3). */
function closeTo(got: number, want: number): void {
  expect(Math.abs(got - want) / Math.abs(want)).toBeLessThan(REL);
}

describe('Albini sub-functions match BehavePlus spot.cpp in native units', () => {
  it('thermal-energy factor f = 322·(0.474·U)^-1.01', () => {
    closeTo(thermalEnergyFactor(10), 66.8836162796);
    closeTo(thermalEnergyFactor(22.369362920544), 29.6598940199);
    // Stronger wind tilts and dilutes the plume, so f falls with U.
    expect(thermalEnergyFactor(40)).toBeLessThan(thermalEnergyFactor(10));
  });

  it('maximum firebrand height z = 1.055·√(f·I_B)', () => {
    closeTo(firebrandHeightFromSurfaceFire(288.9, 20), 103.33940485);
    // z ∝ √I at fixed wind — a 100× fiercer front lofts brands 10× higher.
    const lo = firebrandHeightFromSurfaceFire(288.9, 20);
    const hi = firebrandHeightFromSurfaceFire(28890, 20);
    expect(hi / lo).toBeCloseTo(10, 6);
    expect(firebrandHeightFromSurfaceFire(0, 20)).toBe(0);
    expect(firebrandHeightFromSurfaceFire(288.9, 0)).toBe(0);
  });

  it('critical cover height 2.2·z^0.337 − 4', () => {
    closeTo(spotCriticalCoverHeight(100), 6.38538691);
    expect(spotCriticalCoverHeight(0)).toBe(0);
  });

  it('flat-terrain distance and the drift term', () => {
    closeTo(spotDistanceFlatTerrain(100, 50, 20), 0.0865256408);
    closeTo(firebrandDrift(100, 20), 0.1074174384);
    expect(spotDistanceFlatTerrain(100, 0, 20)).toBe(0);
  });

  it('the flat-terrain bracket is clamped at zero, and only it', () => {
    // z/h ≈ 0.162 sends 0.362 + √(z/h)/2·ln(z/h) negative — reachable in the
    // sandbox (a marginal front under tall timber in a hard wind), never in
    // BehavePlus' own input ranges, which is why the C++ does not clamp. An
    // unclamped negative would reverse the ember's bearing and spot UPWIND.
    const z = 10.648957;
    const h = 65.616798;
    expect(z / h).toBeLessThan(0.163);
    expect(spotDistanceFlatTerrain(z, h, 55.923407)).toBe(0);
    // The clamp kills the flat term only: the brand still drifts above the canopy.
    closeTo(firebrandDrift(z, 55.923407), 0.071153598033);
  });
});

/**
 * The SI wrapper the sim actually calls. These four cases are the ones quoted in
 * `docs/science.md` §6 and in the `spottingSystem.ts` header; the literals come
 * from the same independent reference, run end-to-end through its own kW/m → Btu
 * and mile → metre conversions.
 */
describe('maxSpotDistanceM — the SI chain, end to end', () => {
  const COVER_M = 15.7; // a 20 m stand at canopy byte 200/255, the spotting-test landscape.

  it('a reference timber front in a 10 m/s wind reaches ≈339 m', () => {
    expect(maxSpotDistanceM(1000, 10, COVER_M)).toBeCloseTo(339.2836, 3);
  });

  it('a 30× fiercer front in the same wind reaches ≈1335 m — the whole point', () => {
    const cool = maxSpotDistanceM(1000, 10, COVER_M);
    const hot = maxSpotDistanceM(30000, 10, COVER_M);
    expect(hot).toBeCloseTo(1335.0387, 3);
    // Before this module, distance was intensity-blind and these were equal.
    expect(hot / cool).toBeGreaterThan(3.5);
  });

  it('the crown height multiplier lands the old ×2.5 distance boost', () => {
    const surface = maxSpotDistanceM(1000, 10, COVER_M, 1);
    const crown = maxSpotDistanceM(1000, 10, COVER_M, 3);
    expect(crown).toBeCloseTo(837.6317, 3);
    // Distance is sub-linear in height: ×3 on z buys ≈2.47× on distance, which is
    // what the hand-tuned CROWN_LOFT_BOOST of 2.5 used to apply directly.
    expect(crown / surface).toBeCloseTo(2.469, 2);
  });

  it('a marginal front in a light wind under tall cover reaches ≈112 m', () => {
    expect(maxSpotDistanceM(300, 4, 20)).toBeCloseTo(112.2766, 3);
  });

  it('short downwind cover carries a brand further than tall timber', () => {
    // Albini's cover height is what catches the brand, so LESS canopy downwind
    // means a LONGER throw — the opposite sign to canopy's role in brand
    // availability, and the reason the two enter the system separately.
    expect(maxSpotDistanceM(1000, 10, 3)).toBeGreaterThan(maxSpotDistanceM(1000, 10, 20));
  });

  it('no fire or no wind means no distance', () => {
    expect(maxSpotDistanceM(0, 10, COVER_M)).toBe(0);
    expect(maxSpotDistanceM(1000, 0, COVER_M)).toBe(0);
  });
});
