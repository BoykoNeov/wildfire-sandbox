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

/** Which Anderson model (1–13) each generic terrain fuel class resolves to. */
export interface TerrainFuelMapping {
  grass: number;
  brush: number;
  timber: number;
}

/** The default mapping (see the module header): FM1 / FM6 / FM9. */
export const DEFAULT_TERRAIN_FUEL_MAPPING: Readonly<TerrainFuelMapping> = {
  grass: TERRAIN_TO_ANDERSON.get(Fuel.Grass)!,
  brush: TERRAIN_TO_ANDERSON.get(Fuel.Brush)!,
  timber: TERRAIN_TO_ANDERSON.get(Fuel.Timber)!,
};

export class TerrainFuelModel implements IFuelModel {
  // Precomputed FuelParams indexed by terrain id (0..4): the mapping is fixed per
  // instance, so resolve it once and keep the per-cell hot-loop lookup a plain
  // array read.
  private readonly table: FuelParams[] = [];

  /**
   * @param mapping Anderson numbers for the three terrain classes. A scenario can
   * remap them (e.g. Timber → FM10, Brush → FM4 chaparral for a crown-fire unit)
   * without touching the fuel layer, the palette or the editor.
   */
  constructor(mapping: TerrainFuelMapping = DEFAULT_TERRAIN_FUEL_MAPPING) {
    const anderson = new Anderson13FuelModel();
    // Nonburnable and CutLine (Phase 4) resolve to Anderson id 0 = nonburnable —
    // a control line is a barrier to the Rothermel model exactly as it is to the
    // CA path, keeping the id purely a palette concern.
    this.table[Fuel.Nonburnable] = anderson.getParams(0);
    this.table[Fuel.CutLine] = anderson.getParams(0);
    this.table[Fuel.Grass] = anderson.getParams(mapping.grass);
    this.table[Fuel.Brush] = anderson.getParams(mapping.brush);
    this.table[Fuel.Timber] = anderson.getParams(mapping.timber);
  }

  getParams(fuelType: number): FuelParams {
    return this.table[fuelType] ?? this.table[Fuel.Nonburnable];
  }
}
