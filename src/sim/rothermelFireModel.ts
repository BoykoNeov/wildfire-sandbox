import { FireState, type WorldState } from '../core/world';
import type { IFireModel } from '../models/IFireModel';
import type { IFuelModel } from '../models/IFuelModel';
import type { RothermelFuel } from '../models/IFuelModel';
import { byteToFraction } from '../core/moisture';
import { deadFuelBed, fuelBed } from './anderson13';
import { canopyCoverFraction, DEFAULT_CANOPY_STAND, type CanopyStand } from './canopyStand';
import { windAdjustmentFactor } from './windAdjustment';
import {
  btuPerFtSecToKwPerM,
  characteristicSAV,
  flameResidenceTime,
  ftPerMinToMetersPerSec,
  metersPerSecToFtPerMin,
  surfaceSpread,
  type SpreadResult,
} from './rothermel';

// 8-neighbour offsets and their cell-distances (cardinals = 1, diagonals = √2).
const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
const NDIST = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

/** Default live-fuel moisture [fraction] — 100%, a green-but-not-peak baseline. */
const DEFAULT_LIVE_MOISTURE = 1.0;

/**
 * What the world's `windU/windV` field means to this model.
 *  - `'midflame'` (default, the Phase-2 §D3 convention): the layer already *is*
 *    the wind at flame height; used as-is. Every existing test is authored this way.
 *  - `'open'`: the layer is the **20-ft open wind** (what a forecast reports); the
 *    model reduces it to midflame per cell with the Albini–Baughman wind adjustment
 *    factor (`windAdjustment.ts`) — deep beds keep more of it, a tree canopy
 *    shelters the surface fuel to a fraction. This is the physically honest
 *    setting for a scenario authored from reported wind speeds.
 */
export type WindReference = 'midflame' | 'open';

/** Construction options. A bare number is accepted as `liveMoisture` (legacy form). */
export interface RothermelFireModelOptions {
  /**
   * Live-fuel moisture [fraction] applied to every live particle when the bed is
   * assembled (the world moisture layer is dead-only — plan §D6). A scenario-level
   * scalar; 1.0 = 100%, a defensible "green live fuel" default that lets the
   * live-bearing shrub models carry. A single value for both live herb and woody.
   */
  liveMoisture?: number;
  /** See {@link WindReference}. Default `'midflame'`. */
  windReference?: WindReference;
  /** Canopy structure for wind sheltering (and crown fire). Default {@link DEFAULT_CANOPY_STAND}. */
  canopy?: CanopyStand;
}

/**
 * Phase-2 fire model: a cellular automaton whose front speed *is* the Rothermel
 * rate of spread (Phase-2 plan §D4). No RNG — spread is deterministic arithmetic,
 * so a seed still reproduces a run byte-for-byte.
 *
 * **Front as discretized arrival time.** Each unburned cell carries a `progress`
 * accumulator in [0, 1). Every tick it advances by the *fastest* arriving front:
 *
 *   progress[i] += max over ignited neighbours n of  ROS(i, n→i) / (dist·cellSize) · dt
 *
 * where `ROS(i, n→i)` is the Rothermel ROS for cell `i`'s own fuel bed with wind
 * and slope projected onto the neighbour→cell direction. When `progress ≥ 1` the
 * cell ignites. A cell crossing one cell of width `cellSize` at rate `ROS` takes
 * `cellSize/ROS` seconds, so the measured front speed equals `ROS` along every
 * neighbour ray (cardinal and diagonal alike — `dist` is in the denominator).
 * `tests/spread-ros.test.ts` is the acceptance gate for this.
 *
 * **Why MAX, not the sum the first plan sketch used (§D4 amendment).** Summing
 * over neighbours overspeeds a planar front by 1+√2 ≈ 2.41× (one cardinal + two
 * diagonal sources), so the measured speed would not equal ROS. The front
 * physically arrives from the *fastest* direction — a min-arrival-time process —
 * and `max` is the forward-Euler discretization of exactly that. This serves
 * §D4's goal ("front speed *is* the ROS"); it does not reverse it.
 *
 * **Why ignited sources include Burned cells (§D4 amendment).** Flame residence
 * `τ = 384/σ` is seconds (~7 s for grass), but on a coarse grid one cell takes
 * many minutes to cross at a realistic no-wind ROS. If only *currently-burning*
 * cells seeded the front it would stall and die the instant a source burned out.
 * A cell that has *ever* ignited keeps pushing the front, which is the arrival-
 * time view; burnout (`Burning → Burned`) is then purely the cosmetic flame
 * duration and is decoupled from spread.
 *
 * **Fireline intensity is an output layer.** When a cell ignites, the Byram
 * fireline intensity of the fastest arriving direction is written to
 * `layers.intensity` (kW/m) — the front's own record of how hard it burned into
 * each cell. Externally-lit cells (ignition tool, ember, backburn) have no arriving
 * front; they get their head-fire intensity (own bed, local wind magnitude, flat)
 * on their first burning tick. Nothing else writes the layer (Handoff §3.1); the
 * crown-fire and spotting science and the renderer only read it.
 *
 * Determinism: sources are read from the pre-tick `fire` buffer (double-buffered
 * like {@link CaFireModel}); each cell writes only its own `progress`. So the
 * sweep is order-independent and reproducible.
 *
 * Conventions (documented per plan §D2/§D3):
 *  - World wind (`windU/windV`) is in m/s, projected onto the spread direction.
 *    By default it is read as **midflame** wind (§D3); with `windReference:
 *    'open'` it is the 20-ft open wind and is reduced to midflame per cell by the
 *    Albini–Baughman wind adjustment factor (fuel-bed depth + canopy sheltering).
 *    See {@link WindReference}.
 *  - Slope is rise/run from the elevation grid, **clamped ≥ 0** — Rothermel's
 *    slope factor is upslope-only (it squares `tan φ`).
 */
export class RothermelFireModel implements IFireModel {
  readonly name = 'fire:rothermel';
  private next: Uint8Array | null = null;
  private progress: Float32Array | null = null;
  // Flame residence time depends only on the fuel's dead bed SAV, so it is the
  // same for every cell of a given fuel id. Cache it per id instead of rebuilding
  // a fuel bed (an allocation) for every burning cell every tick.
  private readonly residenceSecById = new Map<number, number>();

  private readonly liveMoisture: number;
  private readonly windReference: WindReference;
  private readonly canopy: CanopyStand;

  constructor(
    private readonly fuel: IFuelModel,
    opts: RothermelFireModelOptions | number = {},
  ) {
    const o: RothermelFireModelOptions = typeof opts === 'number' ? { liveMoisture: opts } : opts;
    this.liveMoisture = o.liveMoisture ?? DEFAULT_LIVE_MOISTURE;
    this.windReference = o.windReference ?? 'midflame';
    this.canopy = o.canopy ?? DEFAULT_CANOPY_STAND;
  }

  /**
   * Factor that turns this cell's world wind into midflame wind: 1 under the
   * `'midflame'` convention, else the Albini–Baughman WAF for the cell's fuel-bed
   * depth and the canopy over it.
   */
  private midflameFactor(rf: RothermelFuel, canopyByte: number): number {
    if (this.windReference === 'midflame') return 1;
    return windAdjustmentFactor(
      rf.depth,
      canopyCoverFraction(canopyByte),
      this.canopy.standHeightM,
      this.canopy.crownRatio,
    );
  }

  step(world: WorldState, dt: number): void {
    const { width, height, cellSize, layers } = world;
    const fire = layers.fire.data;
    const fuelL = layers.fuel.data;
    const elev = layers.elevation.data;
    const moist = layers.moisture.data;
    const windU = layers.windU.data;
    const windV = layers.windV.data;
    const canopyL = layers.canopy.data;
    const burnElapsed = layers.burnElapsed.data;
    const intensity = layers.intensity.data;

    if (this.next === null || this.next.length !== fire.length) {
      this.next = new Uint8Array(fire.length);
      this.progress = new Float32Array(fire.length);
    }
    const next = this.next;
    const progress = this.progress!;
    next.set(fire);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const state = fire[i];

        if (state === FireState.Burned) continue;

        const fp = this.fuel.getParams(fuelL[i]);
        const rf = fp.rothermel;

        if (state === FireState.Burning) {
          // An externally-lit cell (tool / ember / backburn) has no arriving front
          // and hence no recorded intensity: give it its own head-fire intensity
          // once, so every burning cell carries a defined value for readers.
          if (intensity[i] === 0 && rf) {
            const bed = fuelBed(rf, byteToFraction(moist[i]), this.liveMoisture);
            const speed = Math.hypot(windU[i], windV[i]) * this.midflameFactor(rf, canopyL[i]);
            const r = surfaceSpread(bed, { midflameWind: metersPerSecToFtPerMin(speed), tanSlope: 0 });
            intensity[i] = btuPerFtSecToKwPerM(r.firelineIntensity);
          }
          // Burnout is cosmetic flame duration (Albini residence time τ = 384/σ),
          // independent of spread. No rothermel descriptor ⇒ can't sustain ⇒ out.
          burnElapsed[i] += dt;
          let residenceSec = this.residenceSecById.get(fuelL[i]);
          if (residenceSec === undefined) {
            residenceSec = rf ? flameResidenceTime(bedSAV(rf)) * 60 : 0;
            this.residenceSecById.set(fuelL[i], residenceSec);
          }
          if (burnElapsed[i] >= residenceSec) next[i] = FireState.Burned;
          continue;
        }

        // Unburned: accumulate the fastest arriving front from ignited neighbours.
        if (!fp.burnable || !rf) continue;

        // Cheap reject: skip building the fuel bed unless an ignited neighbour exists.
        let hasSource = false;
        for (let n = 0; n < 8; n++) {
          const nx = x + NX[n];
          const ny = y + NY[n];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (isIgnited(fire[ny * width + nx])) {
            hasSource = true;
            break;
          }
        }
        if (!hasSource) continue;

        const bed = fuelBed(rf, byteToFraction(moist[i]), this.liveMoisture);
        // Wind sampled at THIS (destination) cell — see world.ts windU/windV — and
        // reduced to midflame here, once, since the factor is a property of the cell.
        const waf = this.midflameFactor(rf, canopyL[i]);
        const wu = windU[i] * waf;
        const wv = windV[i] * waf;

        let maxRate = 0; // max ROS_dir / (dist·cellSize)  [1/s]
        let best: SpreadResult | null = null; // the fire behaviour along that direction
        for (let n = 0; n < 8; n++) {
          const nx = x + NX[n];
          const ny = y + NY[n];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!isIgnited(fire[ni])) continue;

          const dist = NDIST[n];
          // Spread direction = from the ignited neighbour toward this cell.
          const dx = -NX[n] / dist;
          const dy = -NY[n] / dist;

          // Wind (m/s) projected onto the spread direction → ft/min, downwind only.
          const windAlong = dx * wu + dy * wv;
          const midflameWind = windAlong > 0 ? metersPerSecToFtPerMin(windAlong) : 0;

          // Slope rise/run from neighbour to this cell; upslope only.
          const run = dist * cellSize;
          const rise = elev[i] - elev[ni];
          const tanSlope = rise > 0 ? rise / run : 0;

          const result = surfaceSpread(bed, { midflameWind, tanSlope });
          const rate = ftPerMinToMetersPerSec(result.rateOfSpread) / run;
          if (rate > maxRate) {
            maxRate = rate;
            best = result;
          }
        }

        progress[i] += maxRate * dt;
        if (progress[i] >= 1) {
          next[i] = FireState.Burning;
          burnElapsed[i] = 0;
          intensity[i] = best ? btuPerFtSecToKwPerM(best.firelineIntensity) : 0;
        }
      }
    }

    fire.set(next);
  }
}

/** A cell is a spread source once it has ever ignited (Burning or Burned). */
function isIgnited(state: number): boolean {
  return state === FireState.Burning || state === FireState.Burned;
}

/**
 * Characteristic SAV σ of a fuel's dead bed — drives the residence time. Moisture
 * is irrelevant to σ, so the bed is assembled at 0 just to reuse {@link deadFuelBed}.
 */
function bedSAV(rf: RothermelFuel): number {
  return characteristicSAV(deadFuelBed(rf, 0).particles);
}
