/**
 * The 40 standard fire-behaviour fuel models of Scott & Burgan (2005, RMRS-GTR-153)
 * as data, plus the fuel models that serve them and the **union** of both standard
 * catalogues.
 *
 * Parameters are transcribed from the USFS Fire Lab BehavePlus source
 * (`firelab/behave`, `src/behave/fuelModels.cpp`), the same source the Anderson 13
 * came from, at revision `aa1b4a07`. Unlike the Anderson rows, the source writes
 * these loads in **tons/acre** with the conversion applied inline as `0.10*f`,
 * `double f = 2000.0/43560.0` — so the rows below keep the published tons/acre
 * literals and apply {@link TONS_PER_ACRE_TO_LB_PER_FT2} in `rowToModel`, and a row
 * still cross-checks against the C++ line by line. `tests/scottBurgan40.test.ts`
 * pins every field against `tests/fixtures/sb40-fuelModels.json`, which is
 * generated from that C++ by `tools/sb40Fixture.mjs` rather than retyped.
 *
 * WHY THIS CATALOGUE. The Anderson 13 have one model (FM2) carrying any live
 * herbaceous load, and BehavePlus marks all thirteen **static**, so the dynamic
 * curing transfer built in Phase 9b had almost nothing to act on
 * (`docs/science.md` §3c). Seventeen of these forty are dynamic, and the grass
 * models carry most of their load as live herbaceous — this is the catalogue in
 * which a season actually changes the fire. The models also distinguish dry- from
 * humid-climate fuels, which the 13 do not, so a "grass" is no longer one thing.
 *
 * SCOPE. Only the 40 **standard** models are here. BehavePlus also ships regional
 * (`SCAL*`), international (`V-*`, `M-*`) and non-burnable (`NB*`) rows; those are
 * out of scope, and two of them carry *different dead and live heat contents*,
 * which the single-`heatContent` fuel bed in `rothermel.ts` cannot represent. All
 * 40 standard models use one heat content for both categories (GR6 at 9000 BTU/lb,
 * the other 39 at 8000) — pinned by the test, since it is what makes the single
 * field honest.
 *
 * TRANSCRIPTION NOTE. TL5's live **woody** SAV reads `160` in `fuelModels.cpp`
 * where the published table and every sibling row say 1600. TL5 carries no live
 * woody load, so the value is inert in every calculation. It is transcribed as the
 * source has it, on the same principle as the `1.333 − 1.11·M` residue in
 * `docs/science.md` §3c: our numbers match the reference implementation's, and a
 * silent correction is a divergence nobody can see.
 */
import { ANDERSON_13 } from './anderson13';
import { CatalogueFuelModel, type CatalogueModel } from './fuelCatalogue';

/** Oven-dry load: published tons/acre → lb/ft² (BehavePlus `f = 2000.0/43560.0`). */
export const TONS_PER_ACRE_TO_LB_PER_FT2 = 2000 / 43560;

/**
 * Raw parameter rows, columns in the SAME order as BehavePlus
 * `setFuelModelRecord(...)` (minus the duplicate live-heat and the `isReserved`
 * flag) so each row cross-checks against `fuelModels.cpp` line by line:
 *
 *   number, code, name,
 *   depth[ft], deadMx[frac], heat[BTU/lb],
 *   load1h, load10h, load100h, loadLiveHerb, loadLiveWoody [**tons/acre**],
 *   savr1h, savrLiveHerb, savrLiveWoody [ft⁻¹],
 *   isDynamic
 */
type Row = [number, string, string, number, number, number, number, number, number, number, number, number, number, number, boolean];

// prettier-ignore
const ROWS: Row[] = [
  // GR — grass. Load is overwhelmingly live herbaceous; every one is dynamic.
  [101, 'GR1', 'Short, sparse, dry climate grass (D)',            0.4, 0.15, 8000, 0.10, 0,    0,    0.30, 0,    2200, 2000, 1500, true],
  [102, 'GR2', 'Low load, dry climate grass (D)',                 1.0, 0.15, 8000, 0.10, 0,    0,    1.0,  0,    2000, 1800, 1500, true],
  [103, 'GR3', 'Low load, very coarse, humid climate grass (D)',  2.0, 0.30, 8000, 0.10, 0.40, 0,    1.50, 0,    1500, 1300, 1500, true],
  [104, 'GR4', 'Moderate load, dry climate grass (D)',            2.0, 0.15, 8000, 0.25, 0,    0,    1.9,  0,    2000, 1800, 1500, true],
  [105, 'GR5', 'Low load, humid climate grass (D)',               1.5, 0.40, 8000, 0.40, 0,    0,    2.50, 0,    1800, 1600, 1500, true],
  [106, 'GR6', 'Moderate load, humid climate grass (D)',          1.5, 0.40, 9000, 0.10, 0,    0,    3.4,  0,    2200, 2000, 1500, true],
  [107, 'GR7', 'High load, dry climate grass (D)',                3.0, 0.15, 8000, 1.0,  0,    0,    5.4,  0,    2000, 1800, 1500, true],
  [108, 'GR8', 'High load, very coarse, humid climate grass (D)', 4.0, 0.30, 8000, 0.5,  1.0,  0,    7.3,  0,    1500, 1300, 1500, true],
  [109, 'GR9', 'Very high load, humid climate grass (D)',         5.0, 0.40, 8000, 1.0,  1.0,  0,    9.0,  0,    1800, 1600, 1500, true],
  // GS — grass-shrub. Live herbaceous AND live woody; all four dynamic.
  [121, 'GS1', 'Low load, dry climate grass-shrub (D)',           0.9, 0.15, 8000, 0.2,  0,    0,    0.5,  0.65, 2000, 1800, 1800, true],
  [122, 'GS2', 'Moderate load, dry climate grass-shrub (D)',      1.5, 0.15, 8000, 0.5,  0.5,  0,    0.6,  1.0,  2000, 1800, 1800, true],
  [123, 'GS3', 'Moderate load, humid climate grass-shrub (D)',    1.8, 0.40, 8000, 0.3,  0.25, 0,    1.45, 1.25, 1800, 1600, 1600, true],
  [124, 'GS4', 'High load, humid climate grass-shrub (D)',        2.1, 0.40, 8000, 1.9,  0.3,  0.1,  3.4,  7.1,  1800, 1600, 1600, true],
  // SH — shrub. Mostly live woody; only SH1 and SH9 carry herbaceous load.
  [141, 'SH1', 'Low load, dry climate shrub (D)',                 1.0, 0.15, 8000, 0.25, 0.25, 0,    0.15, 1.3,  2000, 1800, 1600, true],
  [142, 'SH2', 'Moderate load, dry climate shrub (S)',            1.0, 0.15, 8000, 1.35, 2.4,  0.75, 0,    3.85, 2000, 1800, 1600, false],
  [143, 'SH3', 'Moderate load, humid climate shrub (S)',          2.4, 0.40, 8000, 0.45, 3.0,  0,    0,    6.2,  1600, 1800, 1400, false],
  [144, 'SH4', 'Low load, humid climate timber-shrub (S)',        3.0, 0.30, 8000, 0.85, 1.15, 0.2,  0,    2.55, 2000, 1800, 1600, false],
  [145, 'SH5', 'High load, dry climate shrub (S)',                6.0, 0.15, 8000, 3.6,  2.1,  0,    0,    2.9,  750,  1800, 1600, false],
  [146, 'SH6', 'Low load, humid climate shrub (S)',               2.0, 0.30, 8000, 2.9,  1.45, 0,    0,    1.4,  750,  1800, 1600, false],
  [147, 'SH7', 'Very high load, dry climate shrub (S)',           6.0, 0.15, 8000, 3.5,  5.3,  2.2,  0,    3.4,  750,  1800, 1600, false],
  [148, 'SH8', 'High load, humid climate shrub (S)',              3.0, 0.40, 8000, 2.05, 3.4,  0.85, 0,    4.35, 750,  1800, 1600, false],
  [149, 'SH9', 'Very high load, humid climate shrub (D)',         4.4, 0.40, 8000, 4.5,  2.45, 0,    1.55, 7.0,  750,  1800, 1500, true],
  // TU — timber understory. TU1/TU3 carry grass under the canopy and are dynamic.
  [161, 'TU1', 'Light load, dry climate timber-grass-shrub (D)',  0.6, 0.20, 8000, 0.2,  0.9,  1.5,  0.2,  0.9,  2000, 1800, 1600, true],
  [162, 'TU2', 'Moderate load, humid climate timber-shrub (S)',   1.0, 0.30, 8000, 0.95, 1.8,  1.25, 0,    0.2,  2000, 1800, 1600, false],
  [163, 'TU3', 'Moderate load, humid climate timber-grass-shrub (D)', 1.3, 0.30, 8000, 1.1, 0.15, 0.25, 0.65, 1.1, 1800, 1600, 1400, true],
  [164, 'TU4', 'Dwarf conifer understory (S)',                    0.5, 0.12, 8000, 4.5,  0,    0,    0,    2.0,  2300, 1800, 2000, false],
  [165, 'TU5', 'Very high load, dry climate timber-shrub (S)',    1.0, 0.25, 8000, 4.0,  4.0,  3.0,  0,    3.0,  1500, 1800, 750,  false],
  // TL — timber litter. Dead only, all static; the compact-litter end of the range.
  [181, 'TL1', 'Low load, compact conifer litter (S)',            0.2, 0.30, 8000, 1.0,  2.2,  3.6,  0,    0,    2000, 1800, 1600, false],
  [182, 'TL2', 'Low load broadleaf litter (S)',                   0.2, 0.25, 8000, 1.4,  2.3,  2.2,  0,    0,    2000, 1800, 1600, false],
  [183, 'TL3', 'Moderate load conifer litter (S)',                0.3, 0.20, 8000, 0.5,  2.2,  2.8,  0,    0,    2000, 1800, 1600, false],
  [184, 'TL4', 'Small downed logs (S)',                           0.4, 0.25, 8000, 0.5,  1.5,  4.2,  0,    0,    2000, 1800, 1600, false],
  [185, 'TL5', 'High load conifer litter (S)',                    0.6, 0.25, 8000, 1.15, 2.5,  4.4,  0,    0,    2000, 1800, 160,  false], // 160: see header
  [186, 'TL6', 'High load broadleaf litter (S)',                  0.3, 0.25, 8000, 2.4,  1.2,  1.2,  0,    0,    2000, 1800, 1600, false],
  [187, 'TL7', 'Large downed logs (S)',                           0.4, 0.25, 8000, 0.3,  1.4,  8.1,  0,    0,    2000, 1800, 1600, false],
  [188, 'TL8', 'Long-needle litter (S)',                          0.3, 0.35, 8000, 5.8,  1.4,  1.1,  0,    0,    1800, 1800, 1600, false],
  [189, 'TL9', 'Very high load broadleaf litter (S)',             0.6, 0.35, 8000, 6.65, 3.30, 4.15, 0,    0,    1800, 1800, 1600, false],
  // SB — slash and blowdown. The heavy dead end; the Anderson 11/12/13 successors.
  [201, 'SB1', 'Low load activity fuel (S)',                      1.0, 0.25, 8000, 1.5,  3.0,  11.0, 0,    0,    2000, 1800, 1600, false],
  [202, 'SB2', 'Moderate load activity or low load blowdown (S)', 1.0, 0.25, 8000, 4.5,  4.25, 4.0,  0,    0,    2000, 1800, 1600, false],
  [203, 'SB3', 'High load activity fuel or moderate load blowdown (S)', 1.2, 0.25, 8000, 5.5, 2.75, 3.0, 0, 0,   2000, 1800, 1600, false],
  [204, 'SB4', 'High load blowdown (S)',                          2.7, 0.25, 8000, 5.25, 3.5,  5.25, 0,    0,    2000, 1800, 1600, false],
];

function rowToModel(r: Row): CatalogueModel {
  const [number, code, name, depth, deadMx, heatContent, load1h, load10h, load100h, loadHerb, loadWoody, dead1hSav, liveHerbSav, liveWoodySav, dynamic] = r;
  const t = TONS_PER_ACRE_TO_LB_PER_FT2;
  return {
    number, code, name,
    depth, deadMx, heatContent,
    dead1hLoad: load1h * t,
    dead10hLoad: load10h * t,
    dead100hLoad: load100h * t,
    liveHerbLoad: loadHerb * t,
    liveWoodyLoad: loadWoody * t,
    dead1hSav, liveHerbSav, liveWoodySav,
    dynamic,
  };
}

/** The 40 standard Scott & Burgan models, keyed by model number (101–204). */
export const SCOTT_BURGAN_40: ReadonlyMap<number, CatalogueModel> = new Map(
  ROWS.map((r) => [r[0], rowToModel(r)]),
);

/**
 * Both standard catalogues in one lookup, keyed by published model number: the
 * Anderson 13 at 1–13, the Scott & Burgan 40 at 101–204. The two number ranges
 * were chosen by Scott & Burgan not to collide precisely so that tools can serve
 * them together, and every other tool (and every LANDFIRE raster) uses these
 * numbers.
 */
export const STANDARD_FUEL_MODELS: ReadonlyMap<number, CatalogueModel> = new Map([
  ...ANDERSON_13,
  ...SCOTT_BURGAN_40,
]);

/** Serves the Scott & Burgan 40 alone (numbers 101–204). */
export class ScottBurgan40FuelModel extends CatalogueFuelModel {
  constructor() {
    super(SCOTT_BURGAN_40);
  }
}

/**
 * Serves {@link STANDARD_FUEL_MODELS} — both catalogues at once. This is the
 * fuel model to reach for: a scenario's `fuelMapping` can name an Anderson number
 * for one terrain band and a Scott & Burgan number for another, since the id
 * spaces are disjoint.
 */
export class StandardFuelModel extends CatalogueFuelModel {
  constructor() {
    super(STANDARD_FUEL_MODELS);
  }
}
