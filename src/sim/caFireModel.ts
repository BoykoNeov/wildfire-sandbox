import { FireState, type WorldState } from '../core/world';
import type { IFireModel } from '../models/IFireModel';
import type { IFuelModel } from '../models/IFuelModel';

// 8-neighbour offsets and their cell-distances (cardinals = 1, diagonals = √2).
const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
const NDIST = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

const WIND_COEFF = 0.6; // strength of down-wind alignment boost
const SLOPE_COEFF = 3.0; // strength of up-slope boost (fire runs uphill)

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Phase 1 cellular-automaton fire model (Handoff §4.2). States are
 * Unburned/Burning/Burned; a burning cell ignites neighbours with a probability
 * modulated by fuel, wind, slope and moisture.
 *
 * Double-buffered with a fixed (row-major) iteration order so the seeded RNG is
 * consumed in a deterministic sequence — a given seed is byte-for-byte
 * reproducible. Swap for a Rothermel-rate CA in Phase 2 behind the same seam.
 */
export class CaFireModel implements IFireModel {
  readonly name = 'fire:ca';
  private next: Uint8Array | null = null;

  constructor(private readonly fuel: IFuelModel) {}

  step(world: WorldState, dt: number): void {
    const { width, height, cellSize, rng, layers } = world;
    const fire = layers.fire.data;
    const fuelL = layers.fuel.data;
    const elev = layers.elevation.data;
    const moist = layers.moisture.data;
    const windU = layers.windU.data;
    const windV = layers.windV.data;
    const burnElapsed = layers.burnElapsed.data;

    if (this.next === null || this.next.length !== fire.length) {
      this.next = new Uint8Array(fire.length);
    }
    const next = this.next;
    next.set(fire);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const state = fire[i];

        if (state === FireState.Burned) continue;

        if (state === FireState.Burning) {
          burnElapsed[i] += dt;
          const fp = this.fuel.getParams(fuelL[i]);
          if (burnElapsed[i] >= fp.burnDuration) next[i] = FireState.Burned;
          continue;
        }

        // Unburned: try to catch from burning neighbours.
        const fp = this.fuel.getParams(fuelL[i]);
        if (!fp.burnable) continue;

        const moistFactor = clamp01(1 - moist[i] / 255);
        if (moistFactor <= 0) continue;

        let pNoIgnite = 1;
        for (let n = 0; n < 8; n++) {
          const nx = x + NX[n];
          const ny = y + NY[n];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (fire[ni] !== FireState.Burning) continue;

          const dist = NDIST[n];
          // Spread direction = from the burning neighbour toward this cell.
          const dx = -NX[n] / dist;
          const dy = -NY[n] / dist;

          // Wind: align the spread direction with the local wind vector.
          const align = dx * windU[ni] + dy * windV[ni];
          const windFactor = Math.exp(WIND_COEFF * align);

          // Slope: rise over run from neighbour to this cell (uphill boosts).
          const slope = (elev[i] - elev[ni]) / (dist * cellSize);
          const slopeFactor = Math.exp(SLOPE_COEFF * slope);

          let p = (fp.spreadRate * moistFactor * windFactor * slopeFactor * dt) / dist;
          pNoIgnite *= 1 - clamp01(p);
        }

        const pIgnite = 1 - pNoIgnite;
        if (pIgnite > 0 && rng.next() < pIgnite) {
          next[i] = FireState.Burning;
          burnElapsed[i] = 0;
        }
      }
    }

    fire.set(next);
  }
}
