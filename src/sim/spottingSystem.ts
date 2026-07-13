import { FireState, type WorldState } from '../core/world';
import type { System } from '../core/system';
import type { IFuelModel } from '../models/IFuelModel';
import { byteToFraction } from '../core/moisture';

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
 * layer to find ember *sources*, `canopy` (the torching proxy — timber throws
 * brands, grass barely does), `windU/windV` for transport, and `fuel`+`moisture`
 * at the landing cell for reception; it writes new `Burning` cells back into
 * `fire`. It is an **additive co-writer of the `fire` layer**: the Rothermel/CA
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
    const burnElapsed = layers.burnElapsed.data;

    // Landing ignitions, collected during the sweep and applied after it (see the
    // snapshot-discipline note above). A Set dedupes multiple embers on one cell.
    let ignitions: Set<number> | null = null;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        // Only actively burning cells throw brands (Burned = flamed out).
        if (fire[i] !== FireState.Burning) continue;

        // Torching proxy: canopy bulk-density fraction. Grass (~0.04) barely
        // lofts; timber (~0.78) throws far. 0 (nonburnable/water) never spots.
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

        // dt-robust launch Bernoulli: p = 1 − exp(−rate·dt), so the per-tick
        // chance is consistent whatever dt the caller uses (same form as the
        // moisture step). One ember per cell per tick at most.
        const rate = SPOT_RATE_BASE * canopyFrac * windSpeed;
        const pLaunch = 1 - Math.exp(-rate * dt);
        if (rng.next() >= pLaunch) continue;

        // Heavy-tailed downwind loft distance: exponential (mean = loftScale),
        // so most brands drop near and a few carry far. Scale grows with wind
        // (transport) and canopy (plume height).
        const u = rng.next();
        const loftScale = LOFT_PER_WIND * windSpeed * (0.5 + canopyFrac);
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
 * Launch rate per (canopy-fraction · wind-m/s · second). Tuned so a burning
 * timbered cell (canopy ≈ 0.78) in a stiff ~10 m/s wind throws a brand roughly
 * every several seconds — frequent enough to seed spot fires over a run, rare
 * enough per cell that spotting reads as punctuation, not a second front.
 */
const SPOT_RATE_BASE = 0.02;
/** Loft-distance scale, metres of mean drop per (m/s of wind). */
const LOFT_PER_WIND = 6;
/** Half-width of the downwind scatter cone, radians (~20°). */
const SPREAD_ANGLE_RAD = 0.35;
/** Landing ignition probability at zero moisture; scaled down by dampness. */
const RECEPTION = 0.5;
/** Extinction-moisture fallback for a landing fuel with no Rothermel descriptor. */
const DEFAULT_EXTINCTION_MOISTURE = 0.3;
