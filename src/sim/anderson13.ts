/**
 * The 13 standard fire-behaviour fuel models (Anderson 1982, INT-122) as data,
 * plus `Anderson13FuelModel` — the Phase-2 `IFuelModel` that serves them to the
 * Rothermel fire model.
 *
 * Parameters are transcribed verbatim from the USFS Fire Lab BehavePlus source
 * (`firelab/behave`, `fuelModels.cpp`, sourced there from Scott & Burgan 2005
 * GTR-153). Loads are already oven-dry lb/ft² in that source — no tons/acre
 * conversion. The 10-hr (109) and 100-hr (30) dead SAVs are fixed standard
 * constants, applied when the bed is assembled (BehavePlus `savrDead_[1]/[2]`).
 *
 * SCOPE (Phase 2): the bed is built from the DEAD size classes only, matching
 * the single-category Rothermel 1972 form in `rothermel.ts`. Live fuel loads are
 * carried in the catalogue faithfully but dropped at bed assembly, so the five
 * live-bearing models (FM2, 4, 5, 7, 10) are APPROXIMATE until the dead/live
 * two-category split lands (it needs a live moisture of extinction computed from
 * dead moisture — see the Phase-2 plan). The eight dead-only models are exact.
 */
import type { FuelParams, IFuelModel, RothermelFuel } from '../models/IFuelModel';
import type { FuelBed, FuelParticle } from './rothermel';

/** Standard 10-hr dead-fuel SAV σ [ft⁻¹] (BehavePlus `savrDead_[1]`). */
export const DEAD_10H_SAV = 109;
/** Standard 100-hr dead-fuel SAV σ [ft⁻¹] (BehavePlus `savrDead_[2]`). */
export const DEAD_100H_SAV = 30;

/** A catalogue entry: a fuel model's identity plus its Rothermel descriptors. */
export interface AndersonModel extends RothermelFuel {
  /** Standard model number, 1–13. */
  number: number;
  /** Short code, e.g. "FM1". */
  code: string;
  /** Common name. */
  name: string;
}

/**
 * Raw parameter rows, columns in the SAME order as BehavePlus
 * `setFuelModelRecord(...)` (minus the duplicate live-heat and the two bool
 * flags) so each row cross-checks against `fuelModels.cpp` line by line:
 *
 *   number, code, name,
 *   depth[ft], deadMx[frac], heat[BTU/lb],
 *   load1h, load10h, load100h, loadLiveHerb, loadLiveWoody [lb/ft²],
 *   savr1h, savrLiveHerb, savrLiveWoody [ft⁻¹]
 */
type Row = [number, string, string, number, number, number, number, number, number, number, number, number, number, number];

// prettier-ignore
const ROWS: Row[] = [
  [1,  'FM1',  'Short grass',                    1.0, 0.12, 8000, 0.034, 0,     0,     0,     0,     3500, 1500, 1500],
  [2,  'FM2',  'Timber grass and understory',    1.0, 0.15, 8000, 0.092, 0.046, 0.023, 0.023, 0,     3000, 1500, 1500],
  [3,  'FM3',  'Tall grass',                     2.5, 0.25, 8000, 0.138, 0,     0,     0,     0,     1500, 1500, 1500],
  [4,  'FM4',  'Chaparral',                      6.0, 0.20, 8000, 0.230, 0.184, 0.092, 0,     0.230, 2000, 1500, 1500],
  [5,  'FM5',  'Brush',                          2.0, 0.20, 8000, 0.046, 0.023, 0,     0,     0.092, 2000, 1500, 1500],
  [6,  'FM6',  'Dormant brush, hardwood slash',  2.5, 0.25, 8000, 0.069, 0.115, 0.092, 0,     0,     1750, 1500, 1500],
  [7,  'FM7',  'Southern rough',                 2.5, 0.40, 8000, 0.052, 0.086, 0.069, 0,     0.017, 1750, 1500, 1500],
  [8,  'FM8',  'Short needle litter',            0.2, 0.30, 8000, 0.069, 0.046, 0.115, 0,     0,     2000, 1500, 1500],
  [9,  'FM9',  'Long needle or hardwood litter', 0.2, 0.25, 8000, 0.134, 0.019, 0.007, 0,     0,     2500, 1500, 1500],
  [10, 'FM10', 'Timber litter & understory',     1.0, 0.25, 8000, 0.138, 0.092, 0.230, 0,     0.092, 2000, 1500, 1500],
  [11, 'FM11', 'Light logging slash',            1.0, 0.15, 8000, 0.069, 0.207, 0.253, 0,     0,     1500, 1500, 1500],
  [12, 'FM12', 'Medium logging slash',           2.3, 0.20, 8000, 0.184, 0.644, 0.759, 0,     0,     1500, 1500, 1500],
  [13, 'FM13', 'Heavy logging slash',            3.0, 0.25, 8000, 0.322, 1.058, 1.288, 0,     0,     1500, 1500, 1500],
];

function rowToModel(r: Row): AndersonModel {
  const [number, code, name, depth, deadMx, heatContent, dead1hLoad, dead10hLoad, dead100hLoad, liveHerbLoad, liveWoodyLoad, dead1hSav, liveHerbSav, liveWoodySav] = r;
  return {
    number, code, name,
    depth, deadMx, heatContent,
    dead1hLoad, dead10hLoad, dead100hLoad, liveHerbLoad, liveWoodyLoad,
    dead1hSav, liveHerbSav, liveWoodySav,
  };
}

/** The 13 standard models, keyed by model number (1–13). */
export const ANDERSON_13: ReadonlyMap<number, AndersonModel> = new Map(
  ROWS.map((r) => [r[0], rowToModel(r)]),
);

/** True if a model carries live fuel (so the dead-only bed is approximate). */
export function hasLiveFuel(m: RothermelFuel): boolean {
  return m.liveHerbLoad > 0 || m.liveWoodyLoad > 0;
}

/**
 * Assemble a single-category Rothermel {@link FuelBed} from a fuel model's DEAD
 * size classes at a uniform dead-fuel moisture. The 1-hr class keeps the model's
 * SAV; the 10-hr and 100-hr classes use the standard {@link DEAD_10H_SAV} /
 * {@link DEAD_100H_SAV}. Zero-load classes are omitted (they contribute nothing).
 *
 * Phase-2 simplification: one moisture for all dead classes (the world has a
 * single moisture layer); real BehavePlus tracks 1-/10-/100-hr moistures apart.
 * Live fuel is dropped here — see the module header.
 */
export function deadFuelBed(m: RothermelFuel, deadMoisture: number): FuelBed {
  const classes: Array<[number, number]> = [
    [m.dead1hLoad, m.dead1hSav],
    [m.dead10hLoad, DEAD_10H_SAV],
    [m.dead100hLoad, DEAD_100H_SAV],
  ];
  const particles: FuelParticle[] = classes
    .filter(([load]) => load > 0)
    .map(([load, sav]) => ({ load, sav, moisture: deadMoisture }));
  return {
    particles,
    depth: m.depth,
    moistureOfExtinction: m.deadMx,
    heatContent: m.heatContent,
  };
}

const NONBURNABLE: FuelParams = { burnable: false, spreadRate: 0, burnDuration: 0 };

/**
 * Phase-2 fuel model serving the Anderson 13 catalogue. `getParams` takes a
 * native Anderson model number (1–13); 0 or any unknown id is nonburnable. The
 * mapping from terrain's generic fuel ids onto Anderson numbers is a wiring
 * concern handled where the world is built, not here.
 *
 * The returned `FuelParams` fills the `rothermel` slice; the legacy CA fields
 * (`spreadRate`/`burnDuration`) are inert zeros — this catalogue is meant for the
 * Rothermel fire model, which derives burnout from fuel residence time, not for
 * the Phase-1 CA.
 */
export class Anderson13FuelModel implements IFuelModel {
  getParams(fuelType: number): FuelParams {
    const m = ANDERSON_13.get(fuelType);
    if (!m) return NONBURNABLE;
    return {
      burnable: true,
      spreadRate: 0,
      burnDuration: 0,
      rothermel: {
        dead1hLoad: m.dead1hLoad,
        dead10hLoad: m.dead10hLoad,
        dead100hLoad: m.dead100hLoad,
        liveHerbLoad: m.liveHerbLoad,
        liveWoodyLoad: m.liveWoodyLoad,
        dead1hSav: m.dead1hSav,
        liveHerbSav: m.liveHerbSav,
        liveWoodySav: m.liveWoodySav,
        depth: m.depth,
        deadMx: m.deadMx,
        heatContent: m.heatContent,
      },
    };
  }
}
