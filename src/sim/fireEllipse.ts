/**
 * Elliptical fire shape — the directional half of surface fire spread.
 *
 * Rothermel's rate of spread is a *head-fire* rate: the speed in the single
 * direction of maximum spread. Operational fire science gets every other
 * direction from an **ellipse**: a point ignition under a steady wind grows as
 * an ellipse with the ignition point at its rear focus, whose length-to-breadth
 * ratio is a function of the effective wind speed (Anderson 1983).
 *
 * Ported from `firelab/behave` (the USFS Fire Lab BehavePlus reference
 * implementation): `src/behave/surfaceFire.cpp` for the wind–slope vector sum,
 * the effective-wind back-solve and the rate-at-a-vector; `src/behave/fireSize.cpp`
 * for the length-to-breadth ratio, eccentricity and backing rate.
 *
 * Pure functions of scalars — no world state, no RNG. See
 * `docs/plans/phase-8-elliptical-spread.md`.
 */

import type { BedIntermediates } from './rothermel';

/** ft/min → mi/h. The length-to-breadth correlations are authored in mi/h. */
export const FT_PER_MIN_TO_MPH = 60 / 5280;

/**
 * BehavePlus's cap on the surface length-to-breadth ratio
 * (`FireSize::calculateSurfaceFireLengthToWidthRatio`). Beyond ~8 the Anderson
 * correlation is extrapolating past its data and the eccentricity is already
 * 0.992, i.e. a backing fire at 0.4 % of the head.
 */
export const MAX_LENGTH_TO_BREADTH = 8;

/**
 * Surface-fire length-to-breadth ratio from the effective wind speed [mi/h].
 * Anderson (1983); `FireSize::calculateSurfaceFireLengthToWidthRatio`:
 *
 *   LB = 0.936·e^(0.1147·U) + 0.461·e^(−0.0692·U) − 0.397,  capped at 8
 *
 * Returns exactly 1 (a circle) at zero wind.
 */
export function lengthToBreadthRatio(effectiveWindMph: number): number {
  if (!(effectiveWindMph > 1e-7)) return 1;
  const lb = 0.936 * Math.exp(0.1147 * effectiveWindMph) + 0.461 * Math.exp(-0.0692 * effectiveWindMph) - 0.397;
  if (lb > MAX_LENGTH_TO_BREADTH) return MAX_LENGTH_TO_BREADTH;
  return lb < 1 ? 1 : lb;
}

/**
 * Crown-fire length-to-breadth ratio from the 20-ft wind speed [mi/h].
 * Rothermel (1991) eq. 10; `FireSize::calculateCrownFireLengthToWidthRatio`.
 * A crown fire is a *rounder* fire than the surface fire driving it.
 */
export function crownLengthToBreadthRatio(windMph: number): number {
  return windMph > 1e-7 ? 1 + 0.125 * windMph : 1;
}

/**
 * Eccentricity of the spread ellipse, E = √(LB² − 1)/LB.
 * `FireSize::calculateFireEccentricity`. 0 for a circle, → 1 as the fire
 * stretches out.
 */
export function eccentricity(lengthToBreadth: number): number {
  const x = lengthToBreadth * lengthToBreadth - 1;
  return x > 0 ? Math.sqrt(x) / lengthToBreadth : 0;
}

/**
 * Rate of spread at angle θ off the head direction, for a fire growing **from
 * its ignition point** — the ellipse expressed about its focus:
 *
 *   R(θ) = R_head · (1 − E) / (1 − E·cos θ)
 *
 * `SurfaceFire::calculateSpreadRateAtVector` in `FromIgnitionPoint` mode. Takes
 * `cosTheta` directly because the caller already has it as a dot product.
 *
 * At θ = 0 this is `R_head`; at θ = π it is the backing rate
 * `R_head·(1−E)/(1+E)`. Behave's *other* form (Catchpole et al. 1982) gives the
 * rate perpendicular to the perimeter and is the one to use for fire behaviour
 * *at a point on the fire edge*; ours is an arrival-time front expanding from a
 * source, so the focus form is the right one (plan §"Design decisions").
 */
export function ellipticalRate(headRate: number, ecc: number, cosTheta: number): number {
  if (ecc <= 0) return headRate;
  return (headRate * (1 - ecc)) / (1 - ecc * cosTheta);
}

/** Backing rate R_head·(1−E)/(1+E). `FireSize::calculateBackingSpreadRate`. */
export function backingRate(headRate: number, ecc: number): number {
  return (headRate * (1 - ecc)) / (1 + ecc);
}

/**
 * The wind speed that would *alone* produce a wind factor of `phiEffective`, by
 * inverting Rothermel eq. (47):
 *
 *   U = ((φ_eff · (β/β_op)^E) / C)^(1/B)   [ft/min]
 *
 * `SurfaceFire::calculateEffectiveWindSpeed`. This is how a combined wind+slope
 * fire gets a single "effective wind" to look its shape up with: slope steepens
 * the fire the same way a stronger wind would.
 */
export function effectiveWindSpeed(bi: BedIntermediates, phiEffective: number): number {
  if (!(phiEffective > 0) || bi.windC <= 0 || bi.windB <= 0) return 0;
  return Math.pow((phiEffective * Math.pow(bi.betaRatio, bi.windE)) / bi.windC, 1 / bi.windB);
}

/**
 * The wind–slope resultant, written into `out`.
 * `SurfaceFire::calculateDirectionOfMaxSpread`, done in world (x, y) instead of
 * Behave's upslope-relative frame — the same vector sum without the aspect
 * bookkeeping.
 *
 * Both contributions are *rates*: `R₀·φ_w` along the wind, `R₀·φ_s` up the
 * slope. The head rate is `R₀ + |sum|` — **not** `R₀·(1 + φ_w + φ_s)`, which is
 * only correct when wind and slope point the same way.
 *
 * `windUx/windUy` and `slopeUx/slopeUy` are unit vectors (zero when that
 * contribution is absent). On the degenerate no-wind, no-slope cell the head
 * direction is left as (1, 0) with `headRate = R₀` and `phiEffective = 0`, so
 * the eccentricity comes out 0 and every direction gets R₀.
 */
export interface WindSlopeResultant {
  /** Rate of spread in the direction of maximum spread [same units as R₀]. */
  headRate: number;
  /** Unit vector along the direction of maximum spread. */
  headUx: number;
  headUy: number;
  /** R_head/R₀ − 1: the combined factor an equivalent pure wind would have made. */
  phiEffective: number;
}

export function windSlopeResultant(
  r0: number,
  phiWind: number,
  windUx: number,
  windUy: number,
  phiSlope: number,
  slopeUx: number,
  slopeUy: number,
  out: WindSlopeResultant,
): WindSlopeResultant {
  const wr = r0 * phiWind;
  const sr = r0 * phiSlope;
  const x = wr * windUx + sr * slopeUx;
  const y = wr * windUy + sr * slopeUy;
  const mag = Math.sqrt(x * x + y * y);
  out.headRate = r0 + mag;
  out.phiEffective = r0 > 0 ? mag / r0 : 0;
  if (mag > 0) {
    out.headUx = x / mag;
    out.headUy = y / mag;
  } else {
    out.headUx = 1;
    out.headUy = 0;
  }
  return out;
}
