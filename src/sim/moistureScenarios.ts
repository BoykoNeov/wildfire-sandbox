/**
 * The standard fuel-moisture scenarios, and the live-fuel **greenness curve**
 * drawn through them.
 *
 * Transcribed from the USFS Fire Lab BehavePlus source (`firelab/behave`,
 * `src/behave/moistureScenarios.cpp`, `populateMoistureScenarios()`), the same
 * source the Anderson 13 catalogue comes from. BehavePlus names the 16 cells of a
 * 4 × 4 grid `D1L1`..`D4L4`: four **dead** triples crossed with four **live**
 * pairs. All values here are fractions, as everywhere else in `src/sim`.
 *
 * These are *inputs a scenario author picks*, not state the sim evolves. The
 * reason is run length: the 10-hr and 100-hr dead timelags, and the weeks-long
 * seasonal swing of live fuel, are all far longer than a sandbox burn, so what
 * matters is the condition a run **starts** in. See `docs/science.md` §3a and §3b.
 */

/** A dead-fuel moisture triple: 1-hr, 10-hr, 100-hr [fractions]. */
export interface DeadMoistureTriple {
  dead1h: number;
  dead10h: number;
  dead100h: number;
}

/**
 * The four standard dead triples (BehavePlus `veryLowDead`..`highDead`). Note how
 * narrow they are — one to two percentage points between size classes, which is
 * why splitting the classes is a small lever on spread rate (`docs/science.md` §3a).
 *
 * The 1-hr entry is informational here: in this sandbox the fine class comes from
 * the per-cell `layers.moisture` byte, and only the coarse two are scenario
 * constants.
 */
export const DEAD_MOISTURE: Readonly<Record<'veryLow' | 'low' | 'moderate' | 'high', DeadMoistureTriple>> = {
  veryLow: { dead1h: 0.03, dead10h: 0.04, dead100h: 0.05 },
  low: { dead1h: 0.06, dead10h: 0.07, dead100h: 0.08 },
  moderate: { dead1h: 0.09, dead10h: 0.1, dead100h: 0.11 },
  high: { dead1h: 0.12, dead10h: 0.13, dead100h: 0.14 },
};

/** A live-fuel moisture pair: herbaceous and woody [fractions]. */
export interface LiveMoisturePair {
  liveHerb: number;
  liveWoody: number;
}

/**
 * The four standard live pairs, from fully cured to fully green (BehavePlus
 * `fullyCuredHerb`..`fullyGreenHerb`). Woody runs 30 percentage points wetter
 * than herbaceous at every step: shrubs hold moisture that grass has already lost.
 */
export const LIVE_MOISTURE: Readonly<Record<'fullyCured' | 'twoThirdsCured' | 'oneThirdCured' | 'fullyGreen', LiveMoisturePair>> = {
  fullyCured: { liveHerb: 0.3, liveWoody: 0.6 },
  twoThirdsCured: { liveHerb: 0.6, liveWoody: 0.9 },
  oneThirdCured: { liveHerb: 0.9, liveWoody: 1.2 },
  fullyGreen: { liveHerb: 1.2, liveWoody: 1.5 },
};

/**
 * Live-fuel moisture from a single **greenness** knob: `0` = fully cured (late
 * season, everything brown), `1` = fully green (spring flush). Both BehavePlus
 * columns are evenly spaced, so a straight line through them reproduces all four
 * standard rows exactly at greenness 0, ⅓, ⅔ and 1:
 *
 *   liveHerb  = 0.30 + 0.90·g
 *   liveWoody = 0.60 + 0.90·g
 *
 * Out-of-range values are clamped — extrapolating the line is not supported by
 * anything in the source.
 *
 * **This moves moisture only, and is deliberately not called `curing`.** Curing's
 * other half is moving the cured live-herbaceous **load** into the dead fuel —
 * `herbLoadTransferFraction` in `anderson13.ts`, reached by the fire model's
 * `dynamicHerbLoad` option and **off by default**. The two are consistent when it
 * is on, because that fraction is derived from the very moisture this curve sets
 * (f ≈ 1 − g), but a bare `greenness` dries the live fuel without curing it. So
 * the knob is named for the season, which is what it always does, rather than for
 * curing, which it only half does. See `docs/science.md` §3b and §3c.
 */
export function liveMoistureFromGreenness(greenness: number): LiveMoisturePair {
  const g = greenness < 0 ? 0 : greenness > 1 ? 1 : greenness;
  return { liveHerb: 0.3 + 0.9 * g, liveWoody: 0.6 + 0.9 * g };
}
