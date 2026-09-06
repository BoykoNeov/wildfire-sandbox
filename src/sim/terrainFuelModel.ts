import type { FuelParams, IFuelModel } from '../models/IFuelModel';
import { Fuel } from './basicFuelModel';
import { StandardFuelModel } from './scottBurgan40';

/**
 * Maps the terrain generator's three generic fuel classes (`Fuel.Grass/Brush/
 * Timber`) onto representative **standard fuel models**, then serves their
 * Rothermel params. This is the "terrain id → model number" step the catalogue
 * modules deliberately leave to the world-building layer, kept in ONE module so
 * the two Rothermel wiring sites — `main.ts` and `tools/renderFrame.ts` — share
 * it and can't drift (the same reason the palette is shared).
 *
 * Model numbers are the published ones and both catalogues are served at once
 * (`STANDARD_FUEL_MODELS`): 1–13 are Anderson 13, 101–204 are Scott & Burgan 40.
 * The number ranges are disjoint by design, so a scenario may mix them — grass
 * from one catalogue, timber from the other — without any mode flag.
 *
 * The fuel LAYER stays generic (0–4), so the palette, the Phase-1 `CaFireModel`/
 * `BasicFuelModel` path, and the determinism test are all untouched — only the
 * Rothermel fuel lookup is remapped.
 *
 * Choices for the default. The dead/live two-category split has landed, so
 * FM4/FM5 are available; the default still uses the litter/slash models because
 * they give a clean grass > brush > timber spread ordering for the generic
 * terrain:
 *   Grass  → FM1 (short grass):          fast, low Mx=0.12 (drops out when damp).
 *   Brush  → FM6 (dormant brush/slash):  carries at a moderate rate across the
 *            map's moisture band (Mx=0.25), between grass and timber.
 *   Timber → FM9 (long-needle/hardwood litter): slow surface spread, so timber
 *            reads as clearly slower than grass — the honest "surface fire under
 *            timber is slow" lesson. FM8 (compact litter) is so slow its front is
 *            ~1 cell over a whole demo and reads as static, so FM9 is the pick.
 * The default is deliberately left on the Anderson models: it is what every
 * measured number in `docs/science.md` was taken against, and a scenario that
 * wants the newer catalogue says so (the season pair does — `presets.ts`).
 * Nonburnable (water/rock) and any unknown id fall through to nonburnable.
 */
export const DEFAULT_TERRAIN_TO_FUEL: ReadonlyMap<number, number> = new Map([
  [Fuel.Grass, 1],
  [Fuel.Brush, 6],
  [Fuel.Timber, 9],
]);

/**
 * Which standard fuel model each generic terrain fuel class resolves to, by
 * published number: 1–13 (Anderson 13) or 101–204 (Scott & Burgan 40).
 */
export interface TerrainFuelMapping {
  grass: number;
  brush: number;
  timber: number;
}

/** The default mapping (see the module header): FM1 / FM6 / FM9. */
export const DEFAULT_TERRAIN_FUEL_MAPPING: Readonly<TerrainFuelMapping> = {
  grass: DEFAULT_TERRAIN_TO_FUEL.get(Fuel.Grass)!,
  brush: DEFAULT_TERRAIN_TO_FUEL.get(Fuel.Brush)!,
  timber: DEFAULT_TERRAIN_TO_FUEL.get(Fuel.Timber)!,
};

export class TerrainFuelModel implements IFuelModel {
  // Precomputed FuelParams indexed by terrain id (0..4): the mapping is fixed per
  // instance, so resolve it once and keep the per-cell hot-loop lookup a plain
  // array read.
  private readonly table: FuelParams[] = [];

  /**
   * @param mapping Standard model numbers for the three terrain classes. A
   * scenario can remap them (e.g. Timber → FM10, Brush → FM4 chaparral for a
   * crown-fire unit; Grass → GR2 for a season that cures) without touching the
   * fuel layer, the palette or the editor.
   */
  constructor(mapping: TerrainFuelMapping = DEFAULT_TERRAIN_FUEL_MAPPING) {
    const standard = new StandardFuelModel();
    // Nonburnable and CutLine (Phase 4) resolve to model id 0 = nonburnable — a
    // control line is a barrier to the Rothermel model exactly as it is to the CA
    // path, keeping the id purely a palette concern.
    this.table[Fuel.Nonburnable] = standard.getParams(0);
    this.table[Fuel.CutLine] = standard.getParams(0);
    this.table[Fuel.Grass] = standard.getParams(mapping.grass);
    this.table[Fuel.Brush] = standard.getParams(mapping.brush);
    this.table[Fuel.Timber] = standard.getParams(mapping.timber);
  }

  getParams(fuelType: number): FuelParams {
    return this.table[fuelType] ?? this.table[Fuel.Nonburnable];
  }
}
