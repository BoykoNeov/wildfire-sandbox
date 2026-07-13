import { Layer, uint8Layer, float32Layer } from './grid';
import { Rng } from './rng';
import { createClock, type SimClock } from './clock';
import type { IgnitableEntity } from '../models/IgnitableEntity';

/**
 * Named simulation layers. Systems communicate ONLY through these — never by
 * calling each other (Handoff §3.1). This is what makes models swappable.
 */
export interface Layers {
  /** Elevation heightfield (metres) — drives slope/aspect. */
  elevation: Layer<Float32Array>;
  /** Fuel-type id -> IFuelModel params. 0 = nonburnable. */
  fuel: Layer<Uint8Array>;
  /**
   * Dead-fuel moisture, 0..255 (0 = bone dry, 255 = 100%). Linear byte↔fraction
   * via `core/moisture.ts`; the fire model reads a fraction, the editor writes
   * bytes. Live-fuel moisture is a separate concern (see Phase-2 plan D6).
   */
  moisture: Layer<Uint8Array>;
  /** Canopy bulk-density proxy, 0..255 — for crown-fire coupling (Handoff §2.1). */
  canopy: Layer<Uint8Array>;
  /** Fire state per cell (see FireState). */
  fire: Layer<Uint8Array>;
  /** Seconds a cell has been burning — drives burnout. */
  burnElapsed: Layer<Float32Array>;
  /**
   * Wind field, written by IWeatherProvider, read by IFireModel. A vector pointing
   * the way the wind blows; the Rothermel fire model reads its components as
   * **midflame wind in m/s** (plan §D3). (The legacy Phase-1 `CaFireModel` instead
   * treats them as a dimensionless down-wind alignment strength.)
   */
  windU: Layer<Float32Array>;
  windV: Layer<Float32Array>;
}

/**
 * Spatially-uniform weather drivers, written by `IWeatherProvider`, read by the
 * fuel-moisture system (Phase 3). Mutable fields like {@link SimClock} — a plain
 * data record, not a system. These are *ambient scalars* (one value for the whole
 * map); genuinely per-cell fields (like wind) live in {@link Layers}. Should
 * temperature/humidity ever need to vary spatially they promote to layers exactly
 * as wind already is — no reader changes, same as the Handoff §3.1 seam discipline.
 */
export interface WeatherState {
  /** Air temperature, °C. Drives the dead-fuel EMC target (converted to °F). */
  temperatureC: number;
  /** Relative humidity, percent 0..100. Drives the EMC target. */
  relativeHumidity: number;
  /** Precipitation rate, mm/hr. `> 0` wets fuels toward saturation instead of EMC. */
  rainRate: number;
}

/**
 * The shared world state: plain data only, no behavior (Handoff §3.1).
 * Layers + entities + clock + the seeded RNG + ambient weather.
 */
export interface WorldState {
  readonly width: number;
  readonly height: number;
  /** Metres per cell — gives slope and spread real units. */
  readonly cellSize: number;
  readonly clock: SimClock;
  readonly rng: Rng;
  readonly layers: Layers;
  /** Ambient weather drivers (uniform); written by IWeatherProvider, read by moisture. */
  readonly env: WeatherState;
  /** Unifying IgnitableEntity list (structures, vessels) — empty in Phase 1. */
  readonly entities: IgnitableEntity[];
}

export interface WorldOptions {
  width: number;
  height: number;
  seed: number;
  /** Metres per cell. Default 30. */
  cellSize?: number;
}

export function createWorld(opts: WorldOptions): WorldState {
  const { width, height, seed } = opts;
  const cellSize = opts.cellSize ?? 30;
  const layers: Layers = {
    elevation: float32Layer(width, height),
    fuel: uint8Layer(width, height),
    moisture: uint8Layer(width, height),
    canopy: uint8Layer(width, height),
    fire: uint8Layer(width, height),
    burnElapsed: float32Layer(width, height),
    windU: float32Layer(width, height),
    windV: float32Layer(width, height),
  };
  return {
    width,
    height,
    cellSize,
    clock: createClock(),
    rng: new Rng(seed),
    layers,
    // Mild-fire-weather defaults (25 °C / 40% RH / no rain) so a sim wired without
    // a weather provider still reads defined drivers. A provider overwrites these.
    env: { temperatureC: 25, relativeHumidity: 40, rainRate: 0 },
    entities: [],
  };
}

/** Cell values for the `fire` layer. */
export const FireState = {
  Unburned: 0,
  Burning: 1,
  Burned: 2,
} as const;
export type FireStateValue = (typeof FireState)[keyof typeof FireState];
