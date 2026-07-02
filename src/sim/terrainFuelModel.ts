import type { FuelParams, IFuelModel } from '../models/IFuelModel';
import { Fuel } from './basicFuelModel';
import { Anderson13FuelModel } from './anderson13';

/**
 * Maps the terrain generator's three generic fuel classes (`Fuel.Grass/Brush/
 * Timber`) onto representative Anderson-13 models, then serves their Rothermel
 * params. This is the "terrain id → Anderson number" step the `anderson13.ts`
 * header deliberately leaves to the world-building layer, kept in ONE module so
 * the two Rothermel wiring sites — `main.ts` and `tools/renderFrame.ts` — share
 * it and can't drift (the same reason the palette is shared).
 *
 * The fuel LAYER stays generic (0–3), so the palette, the Phase-1 `CaFireModel`/
 * `BasicFuelModel` path, and the determinism test are all untouched — only the
 * Rothermel fuel lookup is remapped.
 *
 * Choices — dead-only-exact models only. The single-category (dead-only) bed
 * halves FM5 and drops FM4 ~31% (see the `anderson13.ts` header), so the
 * live-bearing shrub models stay out until the dead/live split lands (Phase-2
 * plan §D6). Do not "fix" Brush back to FM4/FM5 before then.
 *   Grass  → FM1 (short grass):          fast, low Mx=0.12 (drops out when damp).
 *   Brush  → FM6 (dormant brush/slash):  dead-only-exact, carries across the map's
 *            moisture band (Mx=0.25); NOT FM4/FM5, which need live fuel.
 *   Timber → FM9 (long-needle/hardwood litter): slow surface spread, so timber
 *            reads as clearly slower than grass — the honest "surface fire under
 *            timber is slow" lesson. FM8 (compact litter) is so slow its front is
 *            ~1 cell over a whole demo and reads as static, so FM9 is the pick.
 * Nonburnable (water/rock) and any unknown id fall through to nonburnable.
 */
export const TERRAIN_TO_ANDERSON: ReadonlyMap<number, number> = new Map([
  [Fuel.Grass, 1],
  [Fuel.Brush, 6],
  [Fuel.Timber, 9],
]);

export class TerrainFuelModel implements IFuelModel {
  // Precomputed FuelParams indexed by terrain id (0..3): the mapping is fixed, so
  // resolve it once and keep the per-cell hot-loop lookup a plain array read.
  private readonly table: FuelParams[] = [];

  constructor() {
    const anderson = new Anderson13FuelModel();
    const ids = [Fuel.Nonburnable, Fuel.Grass, Fuel.Brush, Fuel.Timber];
    for (const id of ids) {
      this.table[id] = anderson.getParams(TERRAIN_TO_ANDERSON.get(id) ?? 0);
    }
  }

  getParams(fuelType: number): FuelParams {
    return this.table[fuelType] ?? this.table[Fuel.Nonburnable];
  }
}
