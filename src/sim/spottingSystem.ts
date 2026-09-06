import { FireState, type WorldState } from '../core/world';
import type { System } from '../core/system';
import type { IFuelModel } from '../models/IFuelModel';
import { byteToFraction } from '../core/moisture';
import { flameLength, kwPerMToBtuPerFtSec } from './rothermel';
import { maxSpotDistanceM } from './spotDistance';
import { DEFAULT_CANOPY_STAND, type CanopyStand } from './canopyStand';
import { unshelteredWaf } from './windAdjustment';
import { DEFAULT_WIND_REFERENCE, type WindReference } from './rothermelFireModel';

/**
 * Phase-3 spotting (Handoff §2.1 "plume rise / spotting = modeled
 * phenomenologically — launch embers as a function of intensity and wind, with a
 * lofting distribution; model the *consequence* of the updraft, not the updraft").
 *
 * A burning cell throws firebrands that ride the wind ahead of the front and
 * start new ignitions across gaps the surface fire can't cross (roads, rock, a
 * cut line). This is the piece that makes real fires unpredictable — a fire can
 * appear far downwind of the main front.
 *
 * **A separate {@link System}, ordered AFTER the fire model** (Handoff §3.1 —
 * systems talk only through layers, never call each other). It reads the `fire`
 * layer to find ember *sources*, `intensity` (the fire model's Byram fireline
 * intensity — how hard the front at that cell is actually burning), `canopy`
 * (brand *availability* and plume height — timber bark and cones loft, grass has
 * nothing to throw), `crown` (the fire model's crown-fire verdict — a torching or
 * running crown multiplies launch rate and loft distance), `windU/windV` for
 * transport, and `fuel`+`moisture` at the landing cell for reception; it writes
 * new `Burning` cells back into `fire`. It is an **additive co-writer of the `fire` layer**: the Rothermel/CA
 * fire model owns surface spread and must run *first*; spotting layers ember
 * ignitions on top. Reordering the pipeline so spotting runs before the fire
 * model would break this contract.
 *
 * **Snapshot / double-buffer discipline.** Ember ignitions are collected during
 * the row-major sweep and applied only *after* it. Writing them live would let a
 * cell ignited by an ember this tick act as a new ember source in the same tick;
 * because embers travel downwind and the sweep is row-major, a downwind
 * (+x/+y) wind would then cascade spot fires across the whole map in a single
 * tick while an upwind wind would not — a direction- and order-dependent bug.
 * Deferring the writes gives clean snapshot semantics (and dedupes two embers
 * landing on one cell for free).
 *
 * **Determinism.** All randomness draws from `world.rng` in a fixed row-major
 * order, so a seed reproduces a run byte-for-byte (Handoff §3.2). Spotting is the
 * only stepping-time `world.rng` consumer in the Rothermel pipeline (the dynamic
 * weather provider uses its own `Rng`; moisture and Rothermel draw none). The
 * determinism golden uses the CA pipeline *without* spotting, so it is untouched.
 *
 * **Heat-driven launch rate.** The launch rate scales with the *recorded fireline
 * intensity* of the front that lit the cell (`layers.intensity`, kW/m), not with
 * canopy standing in for it — that substitution was the Phase-3 deferral this
 * step closes. The scaling is Byram/Albini flame length, `L = 0.45·I^0.46`
 * (`flameLength` in `sim/rothermel.ts`, the same relation the renderer grades and
 * crown initiation is written against), normalised by the flame length of a
 * {@link SPOT_REF_INTENSITY_KW} front so a timbered surface fire keeps its
 * previously-tuned rate. Flame length — not intensity itself — is the right
 * driver: it is the height brands are lifted from, and it compresses the
 * 10²–10⁵ kW/m range the sandbox produces into a ~0.5–8× band instead of a
 * 1000× one. Canopy stays in the formula in its *other* role (brand availability
 * and plume height), and crown state stays too: torching lifts brands out of the
 * canopy itself, which fireline intensity barely registers (in
 * `timber-crown-run`, crowning timber records ~700–900 kW/m against ~380 for the
 * surface fire under it — a ~1.4× flame-length effect, not the ~6× a crown run
 * actually spots at).
 *
 * **Heat-driven loft distance.** How far a brand carries is Albini's maximum
 * spotting distance for a wind-driven surface fire (`sim/spotDistance.ts`,
 * BehavePlus `spot.cpp`), evaluated on the same recorded fireline intensity: the
 * plume lofts a brand to `z = 1.055·√(f·I_B)` feet and it then drifts downwind
 * over the canopy. That closes the last piece of the Phase-3 phenomenology — the
 * launch *rate* has read intensity since Phase 6, but distance was wind × canopy
 * × crown tier with no heat in it at all, so a smouldering front and a fierce one
 * threw brands equally far. Three consequences worth knowing:
 *  - Distance now grows like √I (through z) and then faster still through the
 *    log ratio z/h: at a fixed 10 m/s wind under 15.7 m of canopy, a 1000 kW/m
 *    front reaches 339 m and a 30 000 kW/m front 1335 m — ≈3.9×, where before
 *    they were identical.
 *  - **Canopy now cuts two ways.** It still raises the launch rate (brand
 *    availability), but as Albini's *downwind cover height* it also catches
 *    brands: the same brand over short cover carries much further than over tall
 *    timber. Cover height is taken at the source cell (stand height × its canopy
 *    fraction) — the honest thing is the cover where the brand *lands*, but that
 *    is circular, since the landing point is what we are solving for.
 *  - The draw stays exponential, about a mean of {@link SPOT_MEAN_FRACTION} ×
 *    canopy fraction × Albini's maximum, so the tail can exceed that maximum.
 *    That is deliberate, not a bug: Albini's number is the extreme of a whole
 *    brand population and ours is one draw per cell per tick. Capping it would
 *    pile a few percent of every fire's embers onto one radius and draw a visible
 *    arc of spot fires. The canopy term is a **brand-burnout** stand-in, not the
 *    old plume-height proxy returning — see {@link SPOT_MEAN_FRACTION} and
 *    {@link BRAND_SURVIVAL_FLOOR}.
 *
 * **Which wind.** Albini's relations are defined on the **20-ft open** wind. The
 * option {@link SpottingOptions.windReference} says what the world's wind layer
 * is; every shipped preset authors it as `'open'`, so the conversion is the
 * identity there, and under `'midflame'` the 20-ft wind is backed out through the
 * source fuel's unsheltered WAF — the same move the crown proxy makes in
 * `rothermelFireModel.ts`. It shares the fire model's default so the two systems
 * cannot end up reading one wind layer two ways. The launch *rate* deliberately
 * keeps reading the layer wind unconverted: it is a tuned phenomenological rate,
 * not a published relation with a defined measurement height.
 *
 * Deliberately phenomenological, not a firebrand-transport CFD: one ember per
 * burning cell per tick, a heavy-tailed draw against a published maximum
 * distance, and a moisture-gated landing probability. No brand burnout in flight,
 * no plume rise, no ridge/valley correction. It should *feel* right (spot fires
 * bloom downwind of an intense, wind-driven, timbered front and jump firebreaks)
 * without claiming to predict brand lofting.
 */
export interface SpottingOptions {
  /**
   * The canopy stand the `canopy` byte layer modulates — its height is Albini's
   * downwind cover height. Defaults to {@link DEFAULT_CANOPY_STAND}; `loadScenario`
   * passes the scenario's own stand, the same record the fire model gets.
   */
  canopy?: CanopyStand;
  /**
   * What the world's `windU/windV` layer is. Defaults to
   * {@link DEFAULT_WIND_REFERENCE}, the fire model's own default, and
   * `loadScenario` forwards the scenario's setting — so the two systems can never
   * disagree about one wind layer.
   */
  windReference?: WindReference;
}

export class SpottingSystem implements System {
  readonly name = 'fire:spotting';

  private readonly canopy: CanopyStand;
  private readonly windReference: WindReference;
  /** Layer-wind → 20-ft-open-wind factor per fuel id; filled lazily (see `openWindFactor`). */
  private readonly openWindCache = new Float64Array(256).fill(-1);

  constructor(
    private readonly fuel: IFuelModel,
    options: SpottingOptions = {},
  ) {
    this.canopy = options.canopy ?? DEFAULT_CANOPY_STAND;
    this.windReference = options.windReference ?? DEFAULT_WIND_REFERENCE;
  }

  /**
   * Factor turning this cell's layer wind into the 20-ft open wind Albini wants:
   * 1 when the layer already is that wind, else the reciprocal of the fuel's own
   * unsheltered WAF (the reduction a 20-ft wind would have suffered over that
   * bed) — mirroring `RothermelFireModel.openWind`. A fuel with no Rothermel
   * descriptor has no bed depth to reason about and is left unconverted.
   */
  private openWindFactor(fuelId: number): number {
    if (this.windReference === 'open') return 1;
    let f = this.openWindCache[fuelId];
    if (f < 0) {
      const rf = this.fuel.getParams(fuelId).rothermel;
      const waf = rf ? unshelteredWaf(rf.depth) : 0;
      f = waf > 0 ? 1 / waf : 1;
      this.openWindCache[fuelId] = f;
    }
    return f;
  }

  step(world: WorldState, dt: number): void {
    const { width, height, cellSize, rng, layers } = world;
    const fire = layers.fire.data;
    const fuelL = layers.fuel.data;
    const canopy = layers.canopy.data;
    const moist = layers.moisture.data;
    const windU = layers.windU.data;
    const windV = layers.windV.data;
    const crown = layers.crown.data;
    const intensity = layers.intensity.data;
    const burnElapsed = layers.burnElapsed.data;

    // Landing ignitions, collected during the sweep and applied after it (see the
    // snapshot-discipline note above). A Set dedupes multiple embers on one cell.
    let ignitions: Set<number> | null = null;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        // Only actively burning cells throw brands (Burned = flamed out).
        if (fire[i] !== FireState.Burning) continue;

        // Brand availability: canopy bulk-density fraction. Grass (~0.04) has
        // little to throw and no plume height; timber (~0.78) sheds burning bark
        // and cones from height. 0 (nonburnable/water) never spots. This is NOT a
        // stand-in for fire intensity any more — see `heat` below.
        const canopyFrac = canopy[i] / 255;
        if (canopyFrac <= 0) continue;

        // Wind carries the brand and marks the updraft; no wind ⇒ no spotting
        // (also sidesteps an undefined bearing at dead calm). Sampled at the SOURCE
        // cell `i` — the brand lofts from here and rides this cell's wind. (This is
        // transport, not spread ROS: the destination-sampling convention settled on
        // `world.ts` windU/windV is about which cell's wind drives a *front into a
        // cell*, and does not apply to where an ember launched from `i` travels.)
        const wu = windU[i];
        const wv = windV[i];
        const windSpeed = Math.hypot(wu, wv);
        if (windSpeed <= 0) continue;

        // How hard this cell is actually burning, as a flame-length ratio against
        // a reference front (see the header). `intensity` is 0 on a cell no fire
        // model has scored — the legacy Phase-1 CA (no intensity concept), and, for
        // exactly one tick, a cell an ember lit *after* the fire model already ran
        // this tick. Such a cell falls back to the reference rate rather than going
        // silent; do not "fix" this to 0, it would mute spotting under the CA
        // pipeline entirely and let a just-landed brand be a dead source.
        const iKw = intensity[i] > 0 ? intensity[i] : SPOT_REF_INTENSITY_KW;
        const heat = flameLength(kwPerMToBtuPerFtSec(iKw)) / REF_FLAME_LENGTH;

        // dt-robust launch Bernoulli: p = 1 − exp(−rate·dt), so the per-tick
        // chance is consistent whatever dt the caller uses (same form as the
        // moisture step). One ember per cell per tick at most — the structural
        // ceiling on how hard this can saturate, whatever the factors multiply to.
        // A crowning cell (torching or a running crown — `layers.crown`, written
        // by the fire model) is the real ember factory: the convective column
        // lofts far more brands, far higher. Surface fire keeps the base rate.
        const crownType = crown[i];
        const rate =
          SPOT_RATE_BASE * canopyFrac * windSpeed * heat * CROWN_LAUNCH_BOOST[crownType];
        const pLaunch = 1 - Math.exp(-rate * dt);
        if (rng.next() >= pLaunch) continue;

        // Heavy-tailed downwind loft distance: exponential about a fraction of
        // Albini's maximum spotting distance for this front (see the header). The
        // maximum is a real function of how hard the cell burns, the 20-ft wind,
        // the canopy that has to be cleared, and how high a crown run launches its
        // brands; the mean is then cut back by how long a brand from this fuel
        // survives the flight at all.
        const wind20 = windSpeed * this.openWindFactor(fuelL[i]);
        const dMaxM = maxSpotDistanceM(
          iKw,
          wind20,
          this.canopy.standHeightM * canopyFrac,
          CROWN_HEIGHT_BOOST[crownType],
        );
        const u = rng.next();
        const survival = BRAND_SURVIVAL_FLOOR + (1 - BRAND_SURVIVAL_FLOOR) * canopyFrac;
        const distM = -Math.log(1 - u) * SPOT_MEAN_FRACTION * survival * dMaxM;

        // Bearing = wind direction ± a jitter cone (brands scatter about downwind).
        const bearing = Math.atan2(wv, wu) + (rng.next() - 0.5) * 2 * SPREAD_ANGLE_RAD;
        const distCells = distM / cellSize;
        const tx = x + Math.round(Math.cos(bearing) * distCells);
        const ty = y + Math.round(Math.sin(bearing) * distCells);
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue; // brand left the map

        const j = ty * width + tx;
        if (fire[j] !== FireState.Unburned) continue; // already burning/burned

        const fp = this.fuel.getParams(fuelL[j]);
        if (!fp.burnable) continue; // landed on rock/road/water

        // Reception: a brand only takes in fuel drier than its moisture of
        // extinction, and more readily the drier it is.
        const mFrac = byteToFraction(moist[j]);
        const mx = fp.rothermel ? fp.rothermel.deadMx : DEFAULT_EXTINCTION_MOISTURE;
        if (mFrac >= mx) continue; // too wet to catch
        const dryness = 1 - mFrac / mx;
        if (rng.next() < RECEPTION * dryness) {
          (ignitions ??= new Set()).add(j);
        }
      }
    }

    if (ignitions) {
      for (const j of ignitions) {
        // Snapshot guard: only ignite cells still unburned as of the sweep.
        if (fire[j] === FireState.Unburned) {
          fire[j] = FireState.Burning;
          burnElapsed[j] = 0;
        }
      }
    }
  }
}

/**
 * Launch rate per (canopy-fraction · wind-m/s · flame-length-ratio · second).
 * Tuned so a burning timbered cell (canopy ≈ 0.78) in a stiff ~10 m/s wind throws
 * a brand roughly every several seconds — frequent enough to seed spot fires over
 * a run, rare enough per cell that spotting reads as punctuation, not a second
 * front. A timbered surface fire records ≈ {@link SPOT_REF_INTENSITY_KW}-ish
 * intensity, so its flame-length ratio is ≈ 1 and that tuning carries over
 * unchanged from the canopy-proxy version.
 */
const SPOT_RATE_BASE = 0.02;
/**
 * Reference fireline intensity [kW/m] the flame-length ratio is normalised
 * against — a moderate, well-established surface front. Cells burning at this
 * intensity get a ratio of exactly 1, i.e. the historically tuned launch rate;
 * a fierce brush run (FM4 at tens of thousands of kW/m) reaches ~5–8×, a
 * marginal smouldering front drops below 1.
 */
const SPOT_REF_INTENSITY_KW = 1000;
/** Flame length [ft] of the reference front; the divisor of the ratio. */
const REF_FLAME_LENGTH = flameLength(kwPerMToBtuPerFtSec(SPOT_REF_INTENSITY_KW));
/**
 * Mean of the exponential loft draw, as a fraction of Albini's **maximum**
 * spotting distance for the same front (and of the source's canopy fraction —
 * see below). Albini's number is where the furthest brand of a population lands;
 * most drop far shorter, so the per-brand mean has to sit well below it. 0.3
 * lands the reference front — a timbered 1000 kW/m cell in a 10 m/s wind, 339 m
 * maximum → 80 m mean — within 4 % of the 77 m the hand-tuned `LOFT_PER_WIND`
 * produced there, and a crowning cell within 3 % of its old ×2.5 reach, so
 * ordinary timber spotting *feels* unchanged and only the extremes move.
 *
 * **Why canopy multiplies the mean: brand burnout, not plume height.** Albini's
 * distance is how far a brand that *survives the flight* can travel; whether it
 * survives depends on what it is. Timber sheds bark plates and cones that stay
 * alight for minutes; grass and litter throw brands that burn out in seconds.
 * The sandbox has no brand-size or burnout model (`docs/science.md` §9), and the
 * canopy byte is the only handle it has on what kind of brand a cell produces —
 * so canopy scales the *mean flight*, which is burnout's first-order effect
 * (burnout caps flight time; distance is wind × time).
 *
 * This is **not** the old `LOFT_PER_WIND` canopy term returning. That one stood
 * for plume height, and plume height now comes from the fire's own intensity
 * through Albini's `z`. Canopy appears in this system three times, for three
 * different reasons: brand *availability* (launch rate), brand *durability*
 * (here), and Albini's downwind *cover height* that catches brands — which
 * pushes the other way, since less cover means a longer throw.
 *
 * Measured consequence: it is what keeps a fierce grass fire from spotting like
 * timber. Before it, an intense 0.04-canopy grass cell threw brands up to 1.6 km
 * and grass sources produced 599 of `grass-valley`'s 673 spot fires — an
 * open-ground Albini answer with nothing to say that grass brands do not survive
 * the trip.
 */
const SPOT_MEAN_FRACTION = 0.3;
/**
 * The share of a full-canopy brand's flight that a canopy-*free* cell's brand
 * still manages — the intercept of the burnout term above, so survival is
 * `0.05 + 0.95 × canopy fraction` rather than canopy fraction flat.
 *
 * It is not zero because open fuels do throw *something* that survives a little
 * (a clump, a fence post, a cow pat), and it is small because that something is
 * rare. Set at 0.05, which reproduces the previously tuned grass reach almost
 * exactly — a 0.04-canopy cell keeps a ~27 m mean throw against the old
 * formula's ~26 m — while leaving timber (0.795 vs 0.784) untouched. Without it,
 * plain canopy fraction halves grass's reach and takes ~20 % off `grass-valley`'s
 * burned area, a bigger change to a shipped preset than this step has any
 * business making.
 */
const BRAND_SURVIVAL_FLOOR = 0.05;
/** Half-width of the downwind scatter cone, radians (~20°). */
const SPREAD_ANGLE_RAD = 0.35;
/** Landing ignition probability at zero moisture; scaled down by dampness. */
const RECEPTION = 0.5;
/** Extinction-moisture fallback for a landing fuel with no Rothermel descriptor. */
const DEFAULT_EXTINCTION_MOISTURE = 0.3;
/**
 * Launch-rate multiplier by crown state [none, passive, active]. A torching
 * tree throws several times the brands of a surface fire under it; a running
 * crown fire is the classic long-range spotting engine. Index 0 = 1 keeps every
 * surface-only scenario (and the spotting tests) exactly as before.
 *
 * This survives the move to a heat-driven launch rate deliberately: it models
 * brands coming *out of the canopy* (bark plates, cones, lofted from crown
 * height), a source fireline intensity does not see. Measured in
 * `timber-crown-run`, crowning timber records only ~1.8–2.3× the surface fire's
 * intensity — ~1.4× once flame length compresses it — so folding crowning into
 * the heat term alone would quietly gut spotting in the crown scenario.
 */
const CROWN_LAUNCH_BOOST = [1, 3, 6];
/**
 * Firebrand-**height** multiplier by crown state [none, passive, active] — the
 * loft-distance counterpart of {@link CROWN_LAUNCH_BOOST}, and the place crown
 * fire enters Albini's distance.
 *
 * It multiplies the lofted height `z`, not the distance, because that is where
 * crowning physically acts: a torching tree throws brands from the canopy up a
 * far taller column than the surface plume, which is exactly the branch of
 * Albini's model (burning pile, `z = 12.2 × flame height`; torching trees,
 * `z = a·t^b·flame height + tree height/2`) that this system does not implement.
 * Pushing the multiplier through the height rather than the answer means the
 * canopy the brand must clear still gets its say.
 *
 * Values re-derived, not carried over: distance is sub-linear in height, so
 * ×1.6 / ×3.0 on `z` reproduce the ×1.5 / ×2.5 on *distance* that the previous
 * hand-tuned constants gave at the reference front (measured 1.49× / 2.47×).
 * Crown cells also record higher intensity than the surface fire under them, so
 * a crown run now reaches a little further than that on top — which is the
 * intended direction, crowning being the classic long-range spotting engine.
 */
const CROWN_HEIGHT_BOOST = [1, 1.6, 3.0];
