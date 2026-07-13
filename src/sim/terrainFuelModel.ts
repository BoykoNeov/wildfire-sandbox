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
 * Choices. The dead/live two-category split has landed, so FM4/FM5 are now
 * available; the current mapping still uses the litter/slash models because they
 * give a clean grass > brush > timber spread ordering for the generic terrain:
 *   Grass  → FM1 (short grass):          fast, low Mx=0.12 (drops out when damp).
 *   Brush  → FM6 (dormant brush/slash):  carries at a moderate rate across the
 *            map's moisture band (Mx=0.25), between grass and timber.
 *   Timber → FM9 (long-needle/hardwood litter): slow surface spread, so timber
 *            reads as clearly slower than grass — the honest "surface fire under
 *            timber is slow" lesson. FM8 (compact litter) is so slow its front is
 *            ~1 cell over a whole demo and reads as static, so FM9 is the pick.
 * Follow-on demo tuning (deferred): remapping Brush → FM4 (chaparral) or FM5
 * (brush) now works and would give a livelier, live-fuel-driven brush; left out
 * here so this change stays a pure model/doc update, not a demo behaviour change.
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
    // CutLine (Phase 4) is not in TERRAIN_TO_ANDERSON, so it falls through to
    // Anderson id 0 = nonburnable — a control line is a barrier to the Rothermel
    // model exactly as it is to the CA path, keeping the id purely a palette concern.
    const ids = [Fuel.Nonburnable, Fuel.Grass, Fuel.Brush, Fuel.Timber, Fuel.CutLine];
    for (const id of ids) {
      this.table[id] = anderson.getParams(TERRAIN_TO_ANDERSON.get(id) ?? 0);
    }
  }

  getParams(fuelType: number): FuelParams {
    return this.table[fuelType] ?? this.table[Fuel.Nonburnable];
  }
}
