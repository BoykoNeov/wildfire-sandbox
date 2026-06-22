/**
 * Fuel seam (Handoff §3.3): "given a fuel-type id, return spread parameters."
 * Phase 1 uses a basic table; Phase 2 adds the Anderson 13 standard models. Both
 * implement the SAME seam, so swapping fuel catalogues never touches a fire model.
 *
 * `FuelParams` carries two disjoint slices, each consumed by a different fire
 * model:
 *  - the legacy Phase-1 CA fields (`spreadRate`, `burnDuration`), read by
 *    `CaFireModel`;
 *  - an optional `rothermel` descriptor block, read by the Phase-2
 *    Rothermel fire model.
 * A fuel model fills the slice its target fire model needs; the other slice is
 * inert. This keeps the widening additive — `BasicFuelModel` is unchanged.
 */

/**
 * The physical fuel-bed descriptors the Rothermel surface-spread model needs,
 * in native imperial units (the form every Rothermel constant was fitted in).
 *
 * Loads are oven-dry, by size class. The 10-hr and 100-hr dead SAVs are fixed
 * standard constants (109 and 30 ft⁻¹), not stored here — see `anderson13.ts`.
 * Live fuel is carried faithfully but not yet consumed: the Phase-2 fire model
 * builds its bed from the dead classes only (the single-category Rothermel 1972
 * form), so live-bearing models are approximate until the dead/live split lands.
 */
export interface RothermelFuel {
  /** Oven-dry 1-hr dead fuel load w₀ [lb/ft²]. */
  dead1hLoad: number;
  /** Oven-dry 10-hr dead fuel load [lb/ft²]. */
  dead10hLoad: number;
  /** Oven-dry 100-hr dead fuel load [lb/ft²]. */
  dead100hLoad: number;
  /** Oven-dry live herbaceous load [lb/ft²]. */
  liveHerbLoad: number;
  /** Oven-dry live woody load [lb/ft²]. */
  liveWoodyLoad: number;
  /** 1-hr dead surface-area-to-volume ratio σ [ft⁻¹] (varies per model). */
  dead1hSav: number;
  /** Live herbaceous SAV σ [ft⁻¹]. */
  liveHerbSav: number;
  /** Live woody SAV σ [ft⁻¹]. */
  liveWoodySav: number;
  /** Fuel-bed depth δ [ft]. */
  depth: number;
  /** Dead-fuel moisture of extinction M_x [fraction]. */
  deadMx: number;
  /** Low heat content of the dead fuel h [BTU/lb] (typically 8000). */
  heatContent: number;
}

export interface FuelParams {
  /** Nonburnable cells (rock, water, road) never ignite. */
  burnable: boolean;
  /** Base per-second ignition contribution to a neighbour (legacy Phase-1 CA). */
  spreadRate: number;
  /** Seconds a cell burns before it becomes Burned (legacy Phase-1 CA). */
  burnDuration: number;
  /** Physical descriptors for the Rothermel fire model; absent for Phase-1 fuels. */
  rothermel?: RothermelFuel;
}

export interface IFuelModel {
  getParams(fuelType: number): FuelParams;
}
