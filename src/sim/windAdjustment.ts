/**
 * Wind adjustment factor (WAF): 20-ft open wind → midflame wind. Albini &
 * Baughman (1979, INT-221), as formalised for BehavePlus by Andrews (2012,
 * RMRS-GTR-266 "Modeling wind adjustment factor and midflame wind speed for
 * Rothermel's surface fire spread model"). A **pure** module, like `rothermel.ts`.
 *
 * Rothermel's wind factor wants the wind *at flame height* ("midflame"), but
 * forecasts and observations report wind at 20 ft (6.1 m) above the vegetation.
 * The reduction from one to the other is not a constant: a deep fuel bed sticks
 * further up into the log wind profile (less reduction), and a tree canopy
 * shelters the surface fuel dramatically (much more reduction). Ignoring this —
 * treating reported wind as midflame — overdrives fire under timber by 3–10×,
 * which is the single largest wind error a sandbox can make. This is the
 * "future refinement" Phase-2 plan §D3 deferred.
 *
 * Two regimes (Andrews 2012 eq. 3 and eq. 5):
 *
 *   unsheltered  WAF = 1.83 / ln((20 + 0.36·H) / (0.13·H))          H = fuel-bed depth [ft]
 *   sheltered    WAF = 0.555 / ( √(f·H_c) · ln((20 + 0.36·H_c) / (0.13·H_c)) )
 *                  H_c = canopy height [ft], f = crown fill portion = cover·crownRatio/3
 *
 * A stand counts as sheltering when the crown fill portion f ≥ 0.05 (BehavePlus'
 * threshold). Unsheltered values for the Anderson 13 models reproduce the
 * published BehavePlus table (FM1 0.36 · FM3 0.44 · FM4 0.55 · FM8 0.28 …);
 * sheltered timber lands near 0.1–0.15. Pinned by `tests/windAdjustment.test.ts`.
 */

/** Crown fill portion below which a canopy does not shelter the surface wind. */
export const SHELTER_THRESHOLD_FILL = 0.05;

const FT_PER_M = 1 / 0.3048;

/** The shared log-profile term ln((20 + 0.36·H) / (0.13·H)) for a height H [ft]. */
function logProfile(heightFt: number): number {
  return Math.log((20 + 0.36 * heightFt) / (0.13 * heightFt));
}

/** Unsheltered WAF for a fuel bed of depth `depthFt` [ft] (Andrews 2012 eq. 3). */
export function unshelteredWaf(depthFt: number): number {
  if (depthFt <= 0) return 0;
  return 1.83 / logProfile(depthFt);
}

/**
 * Crown fill portion f = canopy cover × crown ratio / 3 — the fraction of the
 * volume below the canopy top that is filled with crown (Andrews 2012 eq. 4).
 */
export function crownFillPortion(coverFraction: number, crownRatio: number): number {
  return (coverFraction * crownRatio) / 3;
}

/** Sheltered WAF under a canopy of height `canopyHeightFt` with crown fill `f` (eq. 5). */
export function shelteredWaf(canopyHeightFt: number, crownFill: number): number {
  if (canopyHeightFt <= 0 || crownFill <= 0) return 0;
  return 0.555 / (Math.sqrt(crownFill * canopyHeightFt) * logProfile(canopyHeightFt));
}

/**
 * The WAF for one cell: sheltered if the canopy over it fills enough of the
 * volume (f ≥ 0.05), else the fuel bed's own unsheltered value. Inputs in the
 * units each descriptor is stored in — fuel depth in ft (Rothermel's native
 * unit), canopy height in metres (the world's unit).
 */
export function windAdjustmentFactor(
  fuelDepthFt: number,
  canopyCoverFraction: number,
  canopyHeightM: number,
  crownRatio: number,
): number {
  const f = crownFillPortion(canopyCoverFraction, crownRatio);
  if (f >= SHELTER_THRESHOLD_FILL && canopyHeightM > 0) {
    return shelteredWaf(canopyHeightM * FT_PER_M, f);
  }
  return unshelteredWaf(fuelDepthFt);
}
