import { FireState, type WorldState } from '../core/world';
import type { System } from '../core/system';
import type { IFuelModel } from '../models/IFuelModel';
import { byteToFraction } from '../core/moisture';
import { flameLength, kwPerMToBtuPerFtSec } from './rothermel';

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
 * Deliberately phenomenological, not a firebrand-transport CFD: one ember per
 * burning cell per tick, an exponential (heavy-tailed) downwind loft distance
 * scaled by wind speed and canopy, and a moisture-gated landing probability. It
 * should *feel* right (spot fires bloom downwind of an intense, wind-driven,
 * timbered front and jump firebreaks) without claiming to predict brand lofting.
 */
export class SpottingSystem implements System {
  readonly name = 'fire:spotting';

  constructor(private readonly fuel: IFuelModel) {}

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
        const iKw = intensity[i];
        const heat = iKw > 0 ? flameLength(kwPerMToBtuPerFtSec(iKw)) / REF_FLAME_LENGTH : 1;

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

        // Heavy-tailed downwind loft distance: exponential (mean = loftScale),
        // so most brands drop near and a few carry far. Scale grows with wind
        // (transport), canopy (plume height) and crowning (column height).
        const u = rng.next();
        const loftScale = LOFT_PER_WIND * windSpeed * (0.5 + canopyFrac) * CROWN_LOFT_BOOST[crownType];
        const distM = -Math.log(1 - u) * loftScale;

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
/** Loft-distance scale, metres of mean drop per (m/s of wind). */
const LOFT_PER_WIND = 6;
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
/** Loft-distance multiplier by crown state — a taller convective column carries further. */
const CROWN_LOFT_BOOST = [1, 1.5, 2.5];
