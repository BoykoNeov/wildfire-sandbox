/**
 * The Rothermel (1972) surface fire-spread model, with Albini's (1976)
 * refinements — the operational science anchor for Phase 2 (handoff §4.2).
 *
 * This module is **pure**: it has NO dependency on world state, layers, or the
 * RNG. It maps a fuel bed + local environment (moisture, midflame wind, slope)
 * to a rate of spread and the associated fire-behaviour outputs (reaction
 * intensity, fireline intensity, flame length). The CA fire model calls into it
 * per cell; keeping it free of world state is what lets us unit-test it against
 * published reference values.
 *
 * Units are **native imperial** throughout (the form in which every constant
 * was fitted and every textbook value is quoted): load lb/ft², SAV ft⁻¹, depth
 * ft, wind ft/min, spread ft/min, intensity BTU/ft²/min. Convert at the
 * boundary with {@link ftPerMinToMetersPerSec}.
 *
 * Equation numbers below refer to Rothermel 1972 (INT-115) and Albini 1976
 * (INT-30). Constants cross-checked against Bevins' firelib v1.04 / BehavePlus.
 */

/** Oven-dry fuel-particle density ρ_p [lb/ft³] (Rothermel: 32). */
export const PARTICLE_DENSITY = 32;
/** Total mineral content S_T [fraction] (Rothermel: 0.0555). */
export const TOTAL_MINERAL_CONTENT = 0.0555;
/** Effective (silica-free) mineral content S_e [fraction] (Rothermel: 0.010). */
export const EFFECTIVE_MINERAL_CONTENT = 0.01;

/** One fuel-particle size class within a fuel bed (e.g. 1-hr dead, live herb). */
export interface FuelParticle {
  /** Oven-dry load w₀ [lb/ft²]. */
  load: number;
  /** Surface-area-to-volume ratio σ [ft⁻¹]. */
  sav: number;
  /** Fuel moisture content M_f [fraction, e.g. 0.06 = 6%]. */
  moisture: number;
}

/** A fuel bed: its particle classes plus bed-level descriptors. */
export interface FuelBed {
  particles: FuelParticle[];
  /** Fuel-bed depth δ [ft]. */
  depth: number;
  /** Dead-fuel moisture of extinction M_x [fraction]. */
  moistureOfExtinction: number;
  /** Low heat content h [BTU/lb] (typically 8000). */
  heatContent: number;
}

/** Local drivers, already projected onto the spread direction of interest. */
export interface SpreadEnv {
  /** Midflame wind speed [ft/min] along the spread direction (≥ 0). */
  midflameWind: number;
  /** Slope steepness as rise/run = tan(slope angle) along spread (≥ 0). */
  tanSlope: number;
}

/** Fire-behaviour outputs for one fuel bed + environment. */
export interface SpreadResult {
  /** Rate of spread R [ft/min]. */
  rateOfSpread: number;
  /** No-wind, no-slope baseline rate of spread R₀ [ft/min]. */
  rateOfSpreadNoWindSlope: number;
  /** Reaction intensity I_R [BTU/ft²/min]. */
  reactionIntensity: number;
  /** Byram's fireline intensity I_B [BTU/ft/s]. */
  firelineIntensity: number;
  /** Byram/Albini flame length L [ft]. */
  flameLength: number;
}

// ───────────────────────── fuel-bed geometry ─────────────────────────

/** Mean bulk density ρ_b = Σw₀ / δ [lb/ft³]. */
export function meanBulkDensity(totalLoad: number, depth: number): number {
  return totalLoad / depth;
}

/** Mean packing ratio β = ρ_b / ρ_p [-]. Rothermel 1972 eq. (74). */
export function meanPackingRatio(bulkDensity: number, particleDensity = PARTICLE_DENSITY): number {
  return bulkDensity / particleDensity;
}

/** Optimum packing ratio β_op = 3.348·σ^-0.8189 [-]. */
export function optimalPackingRatio(sigma: number): number {
  return 3.348 * Math.pow(sigma, -0.8189);
}

/**
 * Characteristic SAV σ = Σ(σ²·w₀) / Σ(σ·w₀) [ft⁻¹]: the surface-area-weighted
 * mean, so fine particles (high σ) dominate. Rothermel 1972 eq. (71),(72).
 */
export function characteristicSAV(particles: FuelParticle[]): number {
  let sw = 0; // Σ σ·w₀
  let s2w = 0; // Σ σ²·w₀
  for (const p of particles) {
    sw += p.sav * p.load;
    s2w += p.sav * p.sav * p.load;
  }
  return sw > 0 ? s2w / sw : 0;
}

// ───────────────────────── reaction intensity ─────────────────────────

/**
 * Potential reaction velocity Γ′ [min⁻¹]. Rothermel 1972 eq. (68),(70);
 * Albini 1976 p.88. `betaRatio` = β/β_op.
 */
export function reactionVelocity(sigma: number, betaRatio: number): number {
  const sigma15 = Math.pow(sigma, 1.5);
  const a = 133 / Math.pow(sigma, 0.7913); // Albini
  const gammaMax = sigma15 / (495 + 0.0594 * sigma15);
  return gammaMax * Math.pow(betaRatio, a) * Math.exp(a * (1 - betaRatio));
}

/**
 * Moisture damping coefficient η_M [-]. Rothermel 1972 eq. (64). The ratio
 * r_M = M_f/M_x is capped at 1, so η_M reaches 0 exactly at the moisture of
 * extinction — at or above it the fuel cannot carry fire.
 */
export function moistureDamping(moisture: number, moistureOfExtinction: number): number {
  // At/above the moisture of extinction the fuel cannot carry fire — return a
  // hard 0 (the damping polynomial is mathematically 0 at r = 1 but leaves a
  // float residual, which would otherwise leak a sliver of spread).
  if (moistureOfExtinction <= 0 || moisture >= moistureOfExtinction) return 0;
  const r = moisture / moistureOfExtinction;
  return Math.max(0, 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r);
}

/**
 * Mineral damping coefficient η_s = min(1, 0.174·S_e^-0.19) [-].
 * Rothermel 1972 eq. (62). With S_e = 0.010 this is ≈ 0.4174.
 */
export function mineralDamping(effectiveMineral = EFFECTIVE_MINERAL_CONTENT): number {
  return Math.min(1, 0.174 * Math.pow(effectiveMineral, -0.19));
}

/** Net (mineral-free) fuel load w_n = w₀·(1 − S_T) [lb/ft²]. */
export function netFuelLoad(load: number, totalMineral = TOTAL_MINERAL_CONTENT): number {
  return load * (1 - totalMineral);
}

/** Reaction intensity I_R = Γ′·w_n·h·η_M·η_s [BTU/ft²/min]. Rothermel eq. (58). */
export function reactionIntensity(
  gamma: number,
  netLoad: number,
  heatContent: number,
  etaM: number,
  etaS: number,
): number {
  return gamma * netLoad * heatContent * etaM * etaS;
}

// ───────────────────────── propagation & heat sink ─────────────────────────

/** Propagating flux ratio ξ [-]. Rothermel 1972 eq. (42),(76). */
export function propagatingFluxRatio(sigma: number, beta: number): number {
  return Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (beta + 0.1)) / (192 + 0.2595 * sigma);
}

/** Effective heating number ε = exp(−138/σ) [-]. Rothermel 1972 eq. (14),(77). */
export function effectiveHeatingNumber(sigma: number): number {
  return sigma > 0 ? Math.exp(-138 / sigma) : 0;
}

/** Heat of preignition Q_ig = 250 + 1116·M_f [BTU/lb]. Rothermel 1972 eq. (12),(78). */
export function heatOfPreignition(moisture: number): number {
  return 250 + 1116 * moisture;
}

/**
 * Heat sink ρ_b·Σ(Q_ig·ε·σ·w₀)/Σ(σ·w₀) [BTU/ft³] — the energy needed to bring a
 * unit volume of the bed to ignition. Rothermel 1972 eq. (77).
 */
export function heatSink(particles: FuelParticle[], bulkDensity: number): number {
  let num = 0; // Σ Q_ig·ε·(σ·w₀)
  let sw = 0; // Σ σ·w₀
  for (const p of particles) {
    const w = p.sav * p.load;
    num += heatOfPreignition(p.moisture) * effectiveHeatingNumber(p.sav) * w;
    sw += w;
  }
  return sw > 0 ? bulkDensity * (num / sw) : 0;
}

// ───────────────────────── wind & slope ─────────────────────────

/** Wind parameter C = 7.47·exp(−0.133·σ^0.55). Rothermel 1972 eq. (48). */
export function windParameterC(sigma: number): number {
  return 7.47 * Math.exp(-0.133 * Math.pow(sigma, 0.55));
}
/** Wind parameter B = 0.02526·σ^0.54. Rothermel 1972 eq. (49). */
export function windParameterB(sigma: number): number {
  return 0.02526 * Math.pow(sigma, 0.54);
}
/** Wind parameter E = 0.715·exp(−0.000359·σ). Rothermel 1972 eq. (50). */
export function windParameterE(sigma: number): number {
  return 0.715 * Math.exp(-0.000359 * sigma);
}

/**
 * Wind factor φ_w = C·U^B·(β/β_op)^-E [-]. Rothermel 1972 eq. (47). `U` is the
 * midflame wind in ft/min; at U = 0 this is 0 (no-wind baseline).
 */
export function windFactor(midflameWind: number, sigma: number, betaRatio: number): number {
  if (midflameWind <= 0) return 0;
  const c = windParameterC(sigma);
  const b = windParameterB(sigma);
  const e = windParameterE(sigma);
  return c * Math.pow(midflameWind, b) * Math.pow(betaRatio, -e);
}

/**
 * Slope factor φ_s = 5.275·β^-0.3·(tan φ)² [-]. Rothermel 1972 eq. (51). Takes
 * the slope as rise/run (tan), since that is what an elevation grid yields.
 */
export function slopeFactor(tanSlope: number, beta: number): number {
  return 5.275 * Math.pow(beta, -0.3) * tanSlope * tanSlope;
}

// ───────────────────────── fire-behaviour outputs ─────────────────────────

/** Flame residence time τ = 384/σ [min]. Albini 1976 p.91. */
export function flameResidenceTime(sigma: number): number {
  return sigma > 0 ? 384 / sigma : 0;
}

/**
 * Byram's fireline intensity I_B = I_R·(R·τ)/60 [BTU/ft/s], where R·τ is the
 * flame-zone depth. Albini 1976 eq. (16).
 */
export function firelineIntensity(reaction: number, rateOfSpread: number, sigma: number): number {
  return (reaction * (rateOfSpread * flameResidenceTime(sigma))) / 60;
}

/** Byram/Albini flame length L = 0.45·I_B^0.46 [ft]. Albini 1976 eq. (17). */
export function flameLength(firelineIntensityValue: number): number {
  return firelineIntensityValue > 0 ? 0.45 * Math.pow(firelineIntensityValue, 0.46) : 0;
}

/** ft/min → m/s (the unit the CA wants): ×0.3048/60. */
export function ftPerMinToMetersPerSec(ftPerMin: number): number {
  return (ftPerMin * 0.3048) / 60;
}

/** m/s → ft/min (the unit the wind factor wants): ×60/0.3048. */
export function metersPerSecToFtPerMin(metersPerSec: number): number {
  return (metersPerSec * 60) / 0.3048;
}

// ───────────────────────── the assembled model ─────────────────────────

/**
 * Run the full Rothermel surface-spread model for one fuel bed + environment.
 *
 *   R = I_R·ξ·(1 + φ_w + φ_s) / (heat sink)        [ft/min]
 *
 * Returns 0 spread when the fuel cannot carry fire (no load, or moisture at/above
 * the moisture of extinction → η_M = 0 → I_R = 0).
 */
export function surfaceSpread(bed: FuelBed, env: SpreadEnv): SpreadResult {
  const zero: SpreadResult = {
    rateOfSpread: 0,
    rateOfSpreadNoWindSlope: 0,
    reactionIntensity: 0,
    firelineIntensity: 0,
    flameLength: 0,
  };

  let totalLoad = 0;
  let sw = 0; // Σ σ·w₀ — surface-area weights
  let swMoisture = 0; // Σ σ·w₀·M_f
  for (const p of bed.particles) {
    totalLoad += p.load;
    const w = p.sav * p.load;
    sw += w;
    swMoisture += w * p.moisture;
  }
  if (totalLoad <= 0 || bed.depth <= 0 || sw <= 0) return zero;

  const sigma = characteristicSAV(bed.particles);
  const bulkDensity = meanBulkDensity(totalLoad, bed.depth);
  const beta = meanPackingRatio(bulkDensity);
  const betaRatio = beta / optimalPackingRatio(sigma);

  // Characteristic fuel moisture = surface-area-weighted mean across particles.
  const moisture = swMoisture / sw;
  const etaM = moistureDamping(moisture, bed.moistureOfExtinction);
  const etaS = mineralDamping();
  if (etaM <= 0) return zero; // at/above moisture of extinction

  const gamma = reactionVelocity(sigma, betaRatio);
  const netLoad = netFuelLoad(totalLoad);
  const ir = reactionIntensity(gamma, netLoad, bed.heatContent, etaM, etaS);

  const xi = propagatingFluxRatio(sigma, beta);
  const hsk = heatSink(bed.particles, bulkDensity);
  if (hsk <= 0) return zero;

  const r0 = (ir * xi) / hsk;
  const phiW = windFactor(env.midflameWind, sigma, betaRatio);
  const phiS = slopeFactor(env.tanSlope, beta);
  const ros = r0 * (1 + phiW + phiS);

  const ib = firelineIntensity(ir, ros, sigma);
  return {
    rateOfSpread: ros,
    rateOfSpreadNoWindSlope: r0,
    reactionIntensity: ir,
    firelineIntensity: ib,
    flameLength: flameLength(ib),
  };
}
