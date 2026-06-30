import { FireState, type WorldState } from '../core/world';
import type { IFireModel } from '../models/IFireModel';
import type { IFuelModel } from '../models/IFuelModel';
import type { RothermelFuel } from '../models/IFuelModel';
import { byteToFraction } from '../core/moisture';
import { deadFuelBed } from './anderson13';
import {
  characteristicSAV,
  flameResidenceTime,
  ftPerMinToMetersPerSec,
  metersPerSecToFtPerMin,
  surfaceSpread,
} from './rothermel';

// 8-neighbour offsets and their cell-distances (cardinals = 1, diagonals = √2).
const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
const NDIST = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

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
 * Determinism: sources are read from the pre-tick `fire` buffer (double-buffered
 * like {@link CaFireModel}); each cell writes only its own `progress`. So the
 * sweep is order-independent and reproducible.
 *
 * Conventions (documented per plan §D2/§D3):
 *  - World wind (`windU/windV`) is treated as **midflame wind in m/s**, projected
 *    onto the spread direction. The real 20-ft-wind → midflame adjustment factor
 *    is a future refinement, not Phase 2.
 *  - Slope is rise/run from the elevation grid, **clamped ≥ 0** — Rothermel's
 *    slope factor is upslope-only (it squares `tan φ`).
 */
export class RothermelFireModel implements IFireModel {
  readonly name = 'fire:rothermel';
  private next: Uint8Array | null = null;
  private progress: Float32Array | null = null;

  constructor(private readonly fuel: IFuelModel) {}

  step(world: WorldState, dt: number): void {
    const { width, height, cellSize, layers } = world;
    const fire = layers.fire.data;
    const fuelL = layers.fuel.data;
    const elev = layers.elevation.data;
    const moist = layers.moisture.data;
    const windU = layers.windU.data;
    const windV = layers.windV.data;
    const burnElapsed = layers.burnElapsed.data;

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
          // Burnout is cosmetic flame duration (Albini residence time τ = 384/σ),
          // independent of spread. No rothermel descriptor ⇒ can't sustain ⇒ out.
          burnElapsed[i] += dt;
          const residenceSec = rf ? flameResidenceTime(bedSAV(rf)) * 60 : 0;
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

        const bed = deadFuelBed(rf, byteToFraction(moist[i]));
        const wu = windU[i];
        const wv = windV[i];

        let maxRate = 0; // max ROS_dir / (dist·cellSize)  [1/s]
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

          const ros = surfaceSpread(bed, { midflameWind, tanSlope }).rateOfSpread;
          const rate = ftPerMinToMetersPerSec(ros) / run;
          if (rate > maxRate) maxRate = rate;
        }

        progress[i] += maxRate * dt;
        if (progress[i] >= 1) {
          next[i] = FireState.Burning;
          burnElapsed[i] = 0;
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
