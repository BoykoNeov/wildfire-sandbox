/**
 * Crown fire — the handoff §2.1 design: "two coupled surface layers (surface
 * fuel + canopy) with a transition threshold; when surface fireline intensity
 * exceeds a criterion, crowning occurs. Vertical fire structure from stacked
 * 2D, not 3D." A **pure** module (no world state), like `rothermel.ts`.
 *
 * The operational lineage, exactly as FARSITE / BehavePlus / FlamMap assemble it:
 *
 *  1. **Initiation — Van Wagner (1977) eq. 4.** Surface fire ignites the canopy
 *     when its Byram intensity reaches
 *        I_0 = (0.010 · CBH · (460 + 25.9 · FMC))^1.5   [kW/m]
 *     with crown base height CBH [m] and foliar moisture FMC [% oven-dry]. A
 *     high, moist crown needs a ferocious surface fire; a low, dry one torches
 *     under a modest one.
 *
 *  2. **Active vs passive — Van Wagner (1977) eq. 8.** A crown fire sustains
 *     itself as a solid flaming front only if fuel is fed through the flame fast
 *     enough: mass flow = CBD · R ≥ 0.05 kg/m²/s, i.e. the spread rate must reach
 *        RAC = 3.0 / CBD   [m/min]   (CBD = canopy bulk density, kg/m³).
 *     Below RAC the crowning is *passive* (torching trees, embers) — still more
 *     intense and spotting-prone than a surface fire, but not a running crown.
 *
 *  3. **Active crown spread rate — Rothermel (1991, INT-438).** The correlation
 *     against wind-driven crown fires in the northern Rockies:
 *        R_active = 3.34 · R_FM10(midflame = 0.4 · U_20ft)
 *     the Rothermel *surface* model run on fuel model 10 with a 0.4 wind
 *     reduction factor, times 3.34. Crown fire spread is thus computed with the
 *     same equations as surface spread — one seam, no new physics engine.
 *
 *  4. **Blending — Van Wagner (1993) / Finney (1998) / Scott & Reinhardt (2001).**
 *     Between initiation and a fully active crown the front carries a crown
 *     fraction burned
 *        CFB = 1 − exp(−a_c · (R_s − R'_init)),   a_c = −ln(0.1) / (0.9 · (RAC − R'_init))
 *     (R'_init = the surface ROS at which I = I_0; CFB reaches 0.9 as R_s reaches
 *     RAC), and the final spread rate is
 *        R = R_s + CFB · (R_active − R_s).
 *     Intensity adds the canopy fuel consumed (Finney 1998):
 *        I = I_s + h_c · CBD · (H − CBH) · CFB · R          [kW/m]
 *
 * Kept honest (handoff §1, §2.1): this is the *operational* crown model, a
 * transition criterion + a correlation, not plume dynamics. It teaches the true
 * things — crown base height and foliar moisture gate crowning; a stand's bulk
 * density decides whether a run sustains; crown fires move several times faster
 * than surface fire under them — without claiming to predict a real run.
 */

/** Crown-fire state of a cell, stored in `layers.crown`. */
export const CrownFire = {
  /** Surface fire only (or never burned). */
  None: 0,
  /** Passive crowning: torching, I ≥ I_0 but R_active < RAC. */
  Passive: 1,
  /** Active crown fire: a running, self-sustaining crown front. */
  Active: 2,
} as const;
export type CrownFireValue = (typeof CrownFire)[keyof typeof CrownFire];

/** Rothermel 1991 crown-run multiplier on the FM10 surface rate. */
export const ACTIVE_CROWN_MULTIPLIER = 3.34;
/** Rothermel 1991 wind reduction factor: midflame for the FM10 crown proxy = 0.4 × 20-ft wind. */
export const CROWN_WIND_REDUCTION = 0.4;
/** Van Wagner 1977 critical mass-flow rate through the crown flame [kg/m²/s]. */
export const CRITICAL_MASS_FLOW = 0.05;
/** Heat of combustion of canopy fuel [kJ/kg] (Finney 1998 / FARSITE default). */
export const CANOPY_HEAT_CONTENT = 18000;

/**
 * Van Wagner (1977) critical surface intensity for crown initiation I_0 [kW/m].
 * `baseHeightM` = crown base height [m]; `foliarMoisturePct` = foliar moisture
 * content [% of oven-dry weight] (fresh conifer foliage ≈ 100%).
 */
export function crownInitiationIntensity(baseHeightM: number, foliarMoisturePct: number): number {
  if (baseHeightM <= 0) return 0;
  return Math.pow(0.01 * baseHeightM * (460 + 25.9 * foliarMoisturePct), 1.5);
}

/**
 * Van Wagner (1977) critical spread rate for *active* crowning RAC [m/min]
 * = 0.05 / CBD × 60 = 3.0 / CBD, with canopy bulk density `cbd` [kg/m³].
 */
export function activeCrownThresholdRos(cbd: number): number {
  if (cbd <= 0) return Infinity;
  return (CRITICAL_MASS_FLOW * 60) / cbd;
}

/** Rothermel (1991) active crown-fire spread rate from the FM10 proxy rate (any unit). */
export function activeCrownRos(fm10SurfaceRos: number): number {
  return ACTIVE_CROWN_MULTIPLIER * fm10SurfaceRos;
}

/**
 * Crown fraction burned (Van Wagner 1993 as used in FARSITE / Scott & Reinhardt
 * 2001): 0 below the initiation rate, rising to 0.9 as the surface rate reaches
 * RAC. All three rates in the same unit. Degenerate cases: once initiated, a
 * stand whose RAC is at or below the initiation rate crowns fully (CFB = 1).
 */
export function crownFractionBurned(surfaceRos: number, initiationRos: number, rac: number): number {
  if (surfaceRos < initiationRos) return 0;
  if (rac <= initiationRos) return 1;
  const ac = -Math.log(0.1) / (0.9 * (rac - initiationRos));
  const cfb = 1 - Math.exp(-ac * (surfaceRos - initiationRos));
  return cfb < 0 ? 0 : cfb > 1 ? 1 : cfb;
}

/** Inputs to one crown-fire evaluation, all for one cell + one spread direction. */
export interface CrownInputs {
  /** Surface fireline intensity I_s [kW/m]. */
  surfaceIntensity: number;
  /** Surface rate of spread R_s [m/min]. */
  surfaceRos: number;
  /** Rothermel-1991 FM10 proxy surface rate at 0.4·U20 [m/min] (pre-multiplier). */
  fm10Ros: number;
  /** Canopy bulk density [kg/m³]. */
  cbd: number;
  /** Crown base height [m]. */
  baseHeightM: number;
  /** Stand height [m]. */
  standHeightM: number;
  /** Foliar moisture [%]. */
  foliarMoisturePct: number;
}

/** Outcome of {@link evaluateCrownFire}. */
export interface CrownResult {
  type: CrownFireValue;
  /** Crown fraction burned, 0..1. */
  cfb: number;
  /** Final rate of spread [m/min] (≥ surface rate). */
  ros: number;
  /** Final fireline intensity [kW/m] (≥ surface intensity). */
  intensity: number;
}

/**
 * Run the whole transition for one cell/direction. Returns the surface values
 * unchanged (type None) when the canopy is absent or the surface fire is below
 * Van Wagner's initiation intensity. Writes into `out` to stay allocation-free
 * in the fire model's hot loop.
 */
export function evaluateCrownFire(inp: CrownInputs, out: CrownResult): CrownResult {
  out.type = CrownFire.None;
  out.cfb = 0;
  out.ros = inp.surfaceRos;
  out.intensity = inp.surfaceIntensity;
  if (inp.cbd <= 0 || inp.surfaceIntensity <= 0 || inp.surfaceRos <= 0) return out;

  const i0 = crownInitiationIntensity(inp.baseHeightM, inp.foliarMoisturePct);
  if (i0 <= 0 || inp.surfaceIntensity < i0) return out;

  const rac = activeCrownThresholdRos(inp.cbd);
  const rActive = activeCrownRos(inp.fm10Ros);
  // I_B ∝ R for a given bed (Byram), so the surface rate at which I = I_0 is
  // R_s · I_0 / I_s.
  const rInit = (inp.surfaceRos * i0) / inp.surfaceIntensity;
  const cfb = crownFractionBurned(inp.surfaceRos, rInit, rac);

  let ros = inp.surfaceRos + cfb * (rActive - inp.surfaceRos);
  if (ros < inp.surfaceRos) ros = inp.surfaceRos; // a crown run never slows the front
  const canopyLoad = inp.cbd * Math.max(0, inp.standHeightM - inp.baseHeightM); // kg/m²
  const intensity = inp.surfaceIntensity + (CANOPY_HEAT_CONTENT * canopyLoad * cfb * ros) / 60;

  out.type = rActive >= rac ? CrownFire.Active : CrownFire.Passive;
  out.cfb = cfb;
  out.ros = ros;
  out.intensity = intensity;
  return out;
}
