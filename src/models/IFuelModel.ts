/**
 * Fuel seam (Handoff §3.3): "given a fuel-type id, return spread parameters."
 * Phase 1 uses a basic table; swap to Anderson 13 / Scott & Burgan 40 later
 * WITHOUT touching the spread logic.
 */
export interface FuelParams {
  /** Nonburnable cells (rock, water, road) never ignite. */
  burnable: boolean;
  /** Base per-second ignition contribution to a neighbour (CA Phase 1). */
  spreadRate: number;
  /** Seconds a cell burns before it becomes Burned. */
  burnDuration: number;
}

export interface IFuelModel {
  getParams(fuelType: number): FuelParams;
}
