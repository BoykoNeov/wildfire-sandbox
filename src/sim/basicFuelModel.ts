import type { FuelParams, IFuelModel } from '../models/IFuelModel';

/**
 * Phase 1 fuel ids — a placeholder for Anderson 13 (Phase 2). `CutLine` (Phase 4)
 * is a firefighter-built control line: a **distinct nonburnable id** so every fire
 * model treats it as a barrier while the renderer can draw it as a hand/dozer
 * scratch (tan) rather than grey rock. The layer staying in `0..4` keeps the CA
 * path and the determinism golden untouched (seed terrain never paints id 4).
 */
export const Fuel = {
  Nonburnable: 0,
  Grass: 1,
  Brush: 2,
  Timber: 3,
  CutLine: 4,
} as const;

const NONBURNABLE: FuelParams = { burnable: false, spreadRate: 0, burnDuration: 0 };

const TABLE: Record<number, FuelParams> = {
  [Fuel.Nonburnable]: NONBURNABLE,
  [Fuel.Grass]: { burnable: true, spreadRate: 0.45, burnDuration: 20 },
  [Fuel.Brush]: { burnable: true, spreadRate: 0.25, burnDuration: 60 },
  [Fuel.Timber]: { burnable: true, spreadRate: 0.12, burnDuration: 180 },
  // A cut line is nonburnable to every fire model; the id only differs for the palette.
  [Fuel.CutLine]: NONBURNABLE,
};

/**
 * Minimal fuel model for the Phase 1 CA. Grass spreads fast and burns out
 * quickly; timber spreads slowly and smoulders long. Swap for an Anderson-13
 * implementation of IFuelModel in Phase 2 without changing the fire model.
 */
export class BasicFuelModel implements IFuelModel {
  getParams(fuelType: number): FuelParams {
    return TABLE[fuelType] ?? NONBURNABLE;
  }
}
