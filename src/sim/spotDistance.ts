/**
 * Albini's maximum spotting distance from a wind-driven surface fire — a **pure**
 * module, like `rothermel.ts` and `windAdjustment.ts`.
 *
 * Albini 1979 (INT-56, "Spot fire distance from burning trees") and Albini 1983
 * (INT-309, "Potential spotting distance from wind-driven surface fires"), as
 * implemented in BehavePlus `src/behave/spot.cpp`
 * (`Spot::calculateSpottingDistanceFromSurfaceFire`, `spotDistanceFlatTerrain`,
 * `calculateSpotCriticalCoverHeight`) — the same source the Anderson 13 table and
 * the wind adjustment factor came from.
 *
 * Three steps, all in Albini's native units (feet, mi/h, miles):
 *
 *   1. **How high a brand is lofted.** `f = 322·(0.474·U)^-1.01` is Albini's
 *      thermal-energy-to-windspeed function (a stronger wind tilts and dilutes
 *      the plume, so it lifts *less* per unit of heat), and the maximum firebrand
 *      height is `z = 1.055·√(f·I_B)` [ft] with `I_B` Byram's fireline intensity
 *      in Btu/ft/s. **This is the intensity term**: z ∝ √I_B, so a ten-fold
 *      fiercer front lofts brands ≈3.2× higher.
 *   2. **How far one drifts while it falls.** `spotDistanceFlatTerrain` is
 *      Albini's flat-terrain drift over a canopy of height `h`, and the separate
 *      `firebrandDrift` term is the extra downwind travel above the canopy. Both
 *      grow linearly with wind; the first grows with the ratio z/h, so a brand
 *      lofted far above a *short* downwind cover carries much further than the
 *      same brand over tall timber that catches it.
 *   3. **The cover-height floor.** Below `2.2·z^0.337 − 4` [ft] the log variation
 *      in step 2 stops behaving, so BehavePlus substitutes that critical height
 *      for the real cover height — which is why open ground does not give an
 *      infinite distance.
 *
 * Two deliberate departures from `spot.cpp`, both documented in `docs/science.md`
 * §6:
 *  - BehavePlus takes a flame *length* and inverts Byram to recover intensity
 *    (`byrams = (L/0.45)^(1/0.46)`). The sandbox records fireline intensity
 *    directly in `layers.intensity`, so {@link maxSpotDistanceM} takes kW/m and
 *    converts, skipping a lossy round trip through the same relation.
 *  - The flat-terrain bracket `0.362 + √(z/h)/2·ln(z/h)` goes **negative** below
 *    z/h ≈ 0.16 — a marginal front under tall timber, which BehavePlus' own input
 *    ranges never reach but a sandbox cell can. It is clamped to zero here; a
 *    negative distance would otherwise reverse the ember's bearing and throw
 *    brands upwind.
 *
 * Not modelled: `spotDistanceMountainTerrain` (the ridge/valley correction — the
 * sandbox has terrain but no ridge-to-valley scenario inputs), the burning-pile
 * and torching-tree branches, and the newer `CrownFirebrandProcessor`. Crown fire
 * enters through the launch-height multiplier in `spottingSystem.ts` instead.
 */

import { kwPerMToBtuPerFtSec } from './rothermel';

const FT_PER_M = 1 / 0.3048;
const MPH_PER_MPS = 2.2369362920544;
const M_PER_MILE = 1609.344;

/**
 * Albini's thermal-energy-to-windspeed function `f = 322·(0.474·U)^-1.01`
 * (`spot.cpp`, "f is a function relating thermal energy to windspeed").
 * `wind20Mph` is the 20-ft open wind.
 */
export function thermalEnergyFactor(wind20Mph: number): number {
  return 322 * Math.pow(0.474 * wind20Mph, -1.01);
}

/**
 * Maximum firebrand height above the fire [ft] for a wind-driven surface fire:
 * `z = 1.055·√(f·I_B)`, with `firelineIntensityBtu` in Btu/ft/s and the 20-ft
 * open wind in mi/h. Zero if either driver is zero.
 */
export function firebrandHeightFromSurfaceFire(
  firelineIntensityBtu: number,
  wind20Mph: number,
): number {
  if (firelineIntensityBtu <= 0 || wind20Mph <= 0) return 0;
  const fi = thermalEnergyFactor(wind20Mph) * firelineIntensityBtu;
  return fi > 0 ? 1.055 * Math.sqrt(fi) : 0;
}

/**
 * The critical cover height `2.2·z^0.337 − 4` [ft] — the floor BehavePlus puts
 * under the cover height so the log variation in {@link spotDistanceFlatTerrain}
 * stays well behaved. May be negative for a very low brand; callers take
 * `max(coverHeight, this)` and then require the result to be positive, exactly as
 * `spot.cpp` does.
 */
export function spotCriticalCoverHeight(firebrandHeightFt: number): number {
  return firebrandHeightFt < 1e-7 ? 0 : 2.2 * Math.pow(firebrandHeightFt, 0.337) - 4;
}

/**
 * Albini's flat-terrain spotting distance [miles] for a brand at height `z` over
 * a downwind cover of height `h`, both [ft], in a 20-ft wind [mi/h]. The bracket
 * is clamped at zero (see the module header).
 */
export function spotDistanceFlatTerrain(
  firebrandHeightFt: number,
  coverHeightFt: number,
  wind20Mph: number,
): number {
  if (coverHeightFt <= 1e-7 || firebrandHeightFt <= 0) return 0;
  const ratio = firebrandHeightFt / coverHeightFt;
  const bracket = 0.362 + (Math.sqrt(ratio) / 2) * Math.log(ratio);
  if (bracket <= 0) return 0;
  return 0.000718 * wind20Mph * Math.sqrt(coverHeightFt) * bracket;
}

/**
 * The firebrand drift term [miles] `0.000278·U·z^0.643` — downwind travel while
 * the brand is still above the canopy, added to the flat-terrain distance.
 */
export function firebrandDrift(firebrandHeightFt: number, wind20Mph: number): number {
  if (firebrandHeightFt <= 0 || wind20Mph <= 0) return 0;
  return 0.000278 * wind20Mph * Math.pow(firebrandHeightFt, 0.643);
}

/**
 * The whole chain in SI, which is what the sandbox holds: maximum spotting
 * distance [m] for a front recording `intensityKwM` kW/m under a `wind20Mps` m/s
 * 20-ft open wind, with `coverHeightM` metres of downwind vegetation to catch the
 * brand.
 *
 * `heightMultiplier` scales the lofted height and is how crown fire enters (a
 * torching or running crown launches brands from the canopy and up a taller
 * column than the surface formula knows about — see `spottingSystem.ts`); it is
 * 1 for a surface fire.
 */
export function maxSpotDistanceM(
  intensityKwM: number,
  wind20Mps: number,
  coverHeightM: number,
  heightMultiplier = 1,
): number {
  if (intensityKwM <= 0 || wind20Mps <= 0) return 0;
  const u = wind20Mps * MPH_PER_MPS;
  const z = firebrandHeightFromSurfaceFire(kwPerMToBtuPerFtSec(intensityKwM), u) * heightMultiplier;
  if (z <= 0) return 0;
  const h = Math.max(coverHeightM * FT_PER_M, spotCriticalCoverHeight(z));
  if (h <= 1e-7) return 0;
  return (spotDistanceFlatTerrain(z, h, u) + firebrandDrift(z, u)) * M_PER_MILE;
}
