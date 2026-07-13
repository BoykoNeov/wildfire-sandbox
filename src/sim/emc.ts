/**
 * Equilibrium moisture content (EMC) of dead forest fuels — Simard (1968).
 *
 * A *pure* module (no world state): given air relative humidity and temperature,
 * return the moisture fraction a dead fuel particle would equilibrate to if held
 * at those conditions indefinitely. This is the target the Phase-3 fuel-moisture
 * dynamics relax the `layers.moisture` byte layer toward (`fuelMoistureSystem.ts`).
 *
 * **Simard's three-branch regression (verbatim, do not "tidy" the coefficients).**
 * Simard fit equilibrium sorption of forest fuels with three regressions over three
 * relative-humidity ranges. Inputs are relative humidity `H` in **percent** and
 * temperature `T` in **degrees Fahrenheit**; output is EMC in **percent** of oven-
 * dry weight:
 *
 *   H < 10          EMC = 0.03229 + 0.281073·H − 0.000578·H·T
 *   10 ≤ H ≤ 50     EMC = 2.22749 + 0.160107·H − 0.014784·T
 *   H > 50          EMC = 21.0606 + 0.005565·H² − 0.00035·H·T − 0.483199·H
 *
 * Source: Simard, A.J. 1968, "The moisture content of forest fuels — I: a review of
 * basic concepts" (Canadian Forestry Service). The same coefficients appear across
 * the NFDRS / BehavePlus dead-fuel-moisture lineage; cross-checked against multiple
 * independent citations before use. `tests/emc.test.ts` pins the published form.
 *
 * The equation is stated in °F because that is the literature's unit; the rest of
 * the sim is metric (elevation m, wind m/s), so {@link equilibriumMoistureFraction}
 * takes °C and converts, keeping the metric convention at the system boundary while
 * this faithful form stays testable against published values.
 */

/** °C → °F. */
export function celsiusToFahrenheit(tempC: number): number {
  return (tempC * 9) / 5 + 32;
}

/**
 * Simard (1968) EMC in **percent**, from relative humidity `H` (percent) and
 * temperature `T` (**°F**). Literature-faithful — the unit test asserts this exact
 * form. Callers inside the metric sim should prefer {@link equilibriumMoistureFraction}.
 */
export function equilibriumMoisturePercent(relativeHumidity: number, temperatureF: number): number {
  const h = relativeHumidity;
  const t = temperatureF;
  if (h < 10) return 0.03229 + 0.281073 * h - 0.000578 * h * t;
  if (h <= 50) return 2.22749 + 0.160107 * h - 0.014784 * t;
  return 21.0606 + 0.005565 * h * h - 0.00035 * h * t - 0.483199 * h;
}

/**
 * Simard EMC as a **fraction** (0..1), from relative humidity (percent) and
 * temperature in **°C** — the metric form the fuel-moisture system uses. Clamped to
 * [0, 1] so it round-trips through the dead-moisture byte encoding (`core/moisture.ts`).
 */
export function equilibriumMoistureFraction(relativeHumidity: number, temperatureC: number): number {
  const percent = equilibriumMoisturePercent(relativeHumidity, celsiusToFahrenheit(temperatureC));
  const fraction = percent / 100;
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
}
