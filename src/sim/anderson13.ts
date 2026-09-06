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
 * SCOPE: all 13 models are now served faithfully. {@link fuelBed} assembles the
 * DEAD *and* LIVE size classes into the two-category Rothermel 1972 form in
 * `rothermel.ts`, so the five live-bearing models (FM2/4/5/7/10) carry their live
 * fuel — FM4 (chaparral) and FM5 (brush), previously untrustworthy dead-only
 * (~31%/~57% of their load is live), are usable. Live fuel takes a scenario-level
 * live-moisture scalar (the world layer is dead-only, plan §D6). {@link
 * deadFuelBed} (dead classes only) is kept for the flame-residence σ and for
 * single-category reference tests.
 *
 * The catalogue is **static**, as the standard 13 are defined to be: nothing here
 * moves load between the size classes on its own. {@link herbLoadTransferFraction}
 * and the `herbLoadTransfer` bed option add BehavePlus's dynamic curing transfer
 * for callers that ask for it — off by default, and see `docs/science.md` §3c for
 * why switching it on is an extension of this catalogue rather than a reading of
 * it.
 *
 * NOTE — net-load change for MULTI-class dead beds (FM6/FM9 and other coarse
 * models): the two-category reaction intensity weights net fuel load by Albini
 * SAV-size-class surface area, whereas the earlier single-category code summed the
 * dead loads raw. The two agree for single-dead-class models (FM1/FM3) but diverge
 * for multi-class beds — FM6 R0 drops to ~0.27×, FM9 to ~0.83×. This corrects an
 * earlier unvalidated simplification (see the Phase-2 plan §D6); it is not a silent
 * reversal. The models are "exact" w.r.t. the published parameters, no longer
 * "dead-only".
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

/** True if a model carries live fuel (so it needs the two-category {@link fuelBed}). */
export function hasLiveFuel(m: RothermelFuel): boolean {
  return m.liveHerbLoad > 0 || m.liveWoodyLoad > 0;
}

/**
 * Per-class moistures that differ from the two positional ones, all optional and
 * all **fractions** (0.08 = 8%). Every field defaults to the positional moisture
 * for its category, so omitting the argument entirely reproduces the older
 * "one dead moisture, one live moisture" bed byte-for-byte.
 *
 * These are *absolute* values, not offsets from the fine class. The coarse dead
 * classes are scenario-level constants rather than a world layer: their 10-hr and
 * 100-hr timelags are far longer than a sandbox run, so what matters is the
 * antecedent condition the run *starts* in (BehavePlus asks for the three dead
 * moistures the same way — `moistureScenarios.cpp`). An *offset* from the live
 * fine layer would be actively wrong, because the fine layer moves within the run
 * and the logs would follow the grass.
 */
export interface BedMoisture {
  /** 10-hr dead-fuel moisture. Default: the 1-hr value. */
  dead10h?: number;
  /** 100-hr dead-fuel moisture. Default: the 1-hr value. */
  dead100h?: number;
  /** Live herbaceous moisture. Default: the positional `liveMoisture`. */
  liveHerb?: number;
  /** Live woody moisture. Default: the positional `liveMoisture`. */
  liveWoody?: number;
}

/**
 * Everything a bed assembly takes beyond the fuel model and the fine dead
 * moisture: the per-class moistures of {@link BedMoisture}, plus the one thing
 * that moves **load** rather than moisture.
 */
export interface BedOptions extends BedMoisture {
  /**
   * Fraction of the live **herbaceous** load moved into the dead fuel, 0..1
   * (BehavePlus `SurfaceFuelbedIntermediates::dynamicLoadTransfer`). Default `0`
   * — the static Anderson 13 bed, byte-for-byte.
   *
   * Derive it from the live herbaceous moisture actually in use with
   * {@link herbLoadTransferFraction}; it is passed in already resolved so that
   * {@link deadFuelBed}, which has no live moisture of its own, can assemble the
   * same dead bed as {@link fuelBed}.
   */
  herbLoadTransfer?: number;
}

/**
 * BehavePlus's dynamic herbaceous **load transfer** as a fraction of the live
 * herbaceous load, from the live herbaceous moisture in use
 * (`surfaceFuelbedIntermediates.cpp`, `dynamicLoadTransfer()`):
 *
 *   M < 30%          → 1     (fully cured: all of it is dead fuel now)
 *   30% ≤ M ≤ 120%   → 1.333 − 1.11·M
 *   M > 120%         → 0     (fully green: none of it has cured)
 *
 * Moisture is the *proxy* for how cured the grass is — cured grass is dry grass —
 * so BehavePlus reads no separate curing input for the standard models, and
 * neither does this. Under the greenness curve (`liveMoistureFromGreenness`,
 * herb = 0.30 + 0.90·g) this comes out as f ≈ 1 − g: a fully cured season
 * transfers all of the herbaceous load, a fully green one essentially none.
 *
 * "Essentially" because the middle branch is transcribed as BehavePlus ships it.
 * The exact line through their two endpoints is `(1.20 − M)/0.9`, which is 0 at
 * M = 1.20; the shipped `1.333 − 1.11·M` is 0.001 there, and the source keeps the
 * exact form commented out beside it with the note "To keep consistant with
 * BehavePlus". That 0.1 % residue is reproduced rather than quietly corrected, so
 * our numbers match the reference implementation's; it is far below anything the
 * sim can show.
 */
export function herbLoadTransferFraction(liveHerbMoisture: number): number {
  if (liveHerbMoisture < 0.3) return 1;
  if (liveHerbMoisture > 1.2) return 0;
  const f = 1.333 - 1.11 * liveHerbMoisture;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Assemble a single-category Rothermel {@link FuelBed} from a fuel model's DEAD
 * size classes. The 1-hr class keeps the model's SAV; the 10-hr and 100-hr
 * classes use the standard {@link DEAD_10H_SAV} / {@link DEAD_100H_SAV}.
 * Zero-load classes are omitted (they contribute nothing).
 *
 * `dead1hMoisture` is the fine dead-fuel moisture — the per-cell world layer. The
 * coarse classes take {@link BedMoisture.dead10h} / {@link BedMoisture.dead100h}
 * when given and the fine value otherwise (plan §D6 item 1). This helper is
 * dead-only by design (flame-residence σ, single-category reference tests);
 * {@link fuelBed} adds the live classes for the full model.
 *
 * {@link BedOptions.herbLoadTransfer} adds a **fourth dead class**: cured
 * herbaceous load, at the model's live-herbaceous SAV and the *fine* dead
 * moisture, exactly as BehavePlus carries it (`loadDead_[3]` / `savrDead_[3]` /
 * `moistureDead_[3]`). It is assembled here rather than only in {@link fuelBed}
 * so a fuel has one dead bed and not two: the same cured grass that carries the
 * fire also drives the flame-residence time.
 */
export function deadFuelBed(m: RothermelFuel, dead1hMoisture: number, options?: BedOptions): FuelBed {
  const transfer = options?.herbLoadTransfer ?? 0;
  const classes: Array<[number, number, number]> = [
    [m.dead1hLoad, m.dead1hSav, dead1hMoisture],
    [m.dead10hLoad, DEAD_10H_SAV, options?.dead10h ?? dead1hMoisture],
    [m.dead100hLoad, DEAD_100H_SAV, options?.dead100h ?? dead1hMoisture],
    [transfer > 0 ? m.liveHerbLoad * transfer : 0, m.liveHerbSav, dead1hMoisture],
  ];
  const particles: FuelParticle[] = classes
    .filter(([load]) => load > 0)
    .map(([load, sav, m_f]) => ({ load, sav, moisture: m_f }));
  return {
    particles,
    depth: m.depth,
    moistureOfExtinction: m.deadMx,
    heatContent: m.heatContent,
  };
}

/**
 * Assemble a **two-category** Rothermel {@link FuelBed} from a fuel model: the
 * dead size classes (as {@link deadFuelBed}) plus the live herbaceous and live
 * woody classes, each tagged `category: 'live'`. This is the bed the two-category
 * `surfaceSpread` needs to honour live-fuel loads faithfully — the eight dead-only
 * models reduce to exactly {@link deadFuelBed}, while the five live-bearing models
 * (FM2/4/5/7/10) include their live fuel.
 *
 * `dead1hMoisture` comes from the world moisture layer, per cell. `liveMoisture`
 * is the scenario-level fallback for both live classes (the moisture layer is
 * dead-only — live moisture runs 100–300% and gets its own representation; see the
 * Phase-2 plan D6 and `src/core/moisture.ts`). The optional {@link BedOptions}
 * splits the coarse dead classes and the two live classes apart and can cure part
 * of the herbaceous load into the dead fuel; omit it and every class falls back to
 * its positional value with no transfer, exactly as before.
 */
export function fuelBed(
  m: RothermelFuel,
  dead1hMoisture: number,
  liveMoisture: number,
  options?: BedOptions,
): FuelBed {
  const bed = deadFuelBed(m, dead1hMoisture, options);
  // What the transfer took is gone from the live side. The subtraction happens
  // BEFORE the `load > 0` guard below, so a fully cured herbaceous class is not
  // pushed at all rather than pushed as a zero-load live particle — which for
  // FM2 (live herb, no live woody) means the bed loses its live category
  // outright, and the two-category weighting sees a dead-only bed, the same
  // shape the eight dead-only models already produce.
  const liveHerbLoad = m.liveHerbLoad * (1 - (options?.herbLoadTransfer ?? 0));
  const live: Array<[number, number, number]> = [
    [liveHerbLoad, m.liveHerbSav, options?.liveHerb ?? liveMoisture],
    [m.liveWoodyLoad, m.liveWoodySav, options?.liveWoody ?? liveMoisture],
  ];
  for (const [load, sav, m_f] of live) {
    if (load > 0) bed.particles.push({ load, sav, moisture: m_f, category: 'live' });
  }
  return bed;
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
  // `FuelParams` are immutable data, so build one object per model number and
  // hand back the same reference on every call. The Rothermel fire model calls
  // `getParams` for every non-burned cell each tick (~millions/sec on a full
  // grid); without this cache each call allocated a fresh nested object, pure GC
  // churn against the per-cell performance invariant. Indexed by fuel id (0–13),
  // not a Map, to keep the hot-loop lookup a plain array read.
  private readonly cache: FuelParams[] = [];

  getParams(fuelType: number): FuelParams {
    const cached = this.cache[fuelType];
    if (cached) return cached;
    const m = ANDERSON_13.get(fuelType);
    const params: FuelParams = m
      ? {
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
        }
      : NONBURNABLE;
    this.cache[fuelType] = params;
    return params;
  }
}
