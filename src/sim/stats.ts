import { FireState, type WorldState } from '../core/world';
import { Fuel } from './basicFuelModel';
import { CrownFire } from './crownFire';
import { byteToFraction } from '../core/moisture';

/**
 * Phase-5a stats (`docs/plans/phase-5-polish.md` decision #3): a **pure
 * function** of world state — no DOM, no canvas, no writes — so it is
 * headless-testable like the fire models, and the HUD is just a formatter.
 *
 * It reports **measured facts only**. There is deliberately no "% contained":
 * real containment is an ICS judgement (fraction of perimeter with control line
 * expected to hold) and deriving one number from the grid would be the
 * over-selling the scope guardrail forbids. "Landscape consumed" is a geometry
 * fact; the front's mean intensity and crown cell counts are the fire model's
 * own outputs.
 */
export interface SimStats {
  /** Simulated seconds. */
  time: number;
  burningCells: number;
  burnedCells: number;
  /** Hectares (cellSize²/10 000 per cell). */
  burningHa: number;
  burnedHa: number;
  /** (burning + burned) / initially-burnable cells, 0..1. */
  consumedFraction: number;
  /** Cells the front took as a passive (torching) / active crown fire. */
  crownPassiveCells: number;
  crownActiveCells: number;
  /** Peak fireline intensity recorded anywhere [kW/m]. */
  maxIntensityKwM: number;
  /** Mean fireline intensity over currently-burning cells [kW/m] (0 if none). */
  frontIntensityKwM: number;
  /** Wind at the map centre cell, m/s (the layer's own reference; see the fire model). */
  windU: number;
  windV: number;
  windSpeed: number;
  temperatureC: number;
  relativeHumidity: number;
  rainRate: number;
  /** Mean dead-fuel moisture over unburned burnable cells, fraction. */
  meanMoisture: number;
  /** Metres of control line (`Fuel.CutLine` cells × cellSize). */
  lineCutM: number;
  /** Cells with active retardant. */
  retardantCells: number;
}

export function emptyStats(): SimStats {
  return {
    time: 0,
    burningCells: 0,
    burnedCells: 0,
    burningHa: 0,
    burnedHa: 0,
    consumedFraction: 0,
    crownPassiveCells: 0,
    crownActiveCells: 0,
    maxIntensityKwM: 0,
    frontIntensityKwM: 0,
    windU: 0,
    windV: 0,
    windSpeed: 0,
    temperatureC: 0,
    relativeHumidity: 0,
    rainRate: 0,
    meanMoisture: 0,
    lineCutM: 0,
    retardantCells: 0,
  };
}

/**
 * One pass over the layers. `burnableCells` is the count captured at load (the
 * denominator for consumption). Writes into `out` to stay allocation-free when
 * called every frame.
 */
export function computeStats(world: WorldState, burnableCells: number, out: SimStats = emptyStats()): SimStats {
  const { width, height, cellSize, layers, env, clock } = world;
  const fire = layers.fire.data;
  const fuel = layers.fuel.data;
  const crown = layers.crown.data;
  const intensity = layers.intensity.data;
  const moist = layers.moisture.data;
  const ret = layers.retardant.data;
  const n = width * height;

  let burning = 0;
  let burned = 0;
  let passive = 0;
  let active = 0;
  let maxI = 0;
  let sumFrontI = 0;
  let line = 0;
  let retardant = 0;
  let moistSum = 0;
  let moistN = 0;

  for (let i = 0; i < n; i++) {
    const f = fire[i];
    if (f === FireState.Burning) {
      burning++;
      sumFrontI += intensity[i];
    } else if (f === FireState.Burned) {
      burned++;
    } else if (fuel[i] !== Fuel.Nonburnable && fuel[i] !== Fuel.CutLine) {
      moistSum += moist[i];
      moistN++;
    }
    if (f !== FireState.Unburned) {
      const c = crown[i];
      if (c === CrownFire.Active) active++;
      else if (c === CrownFire.Passive) passive++;
    }
    const v = intensity[i];
    if (v > maxI) maxI = v;
    if (fuel[i] === Fuel.CutLine) line++;
    if (ret[i] > 0) retardant++;
  }

  const haPerCell = (cellSize * cellSize) / 10000;
  const ci = ((height >> 1) * width + (width >> 1)) | 0;
  const wu = layers.windU.data[ci];
  const wv = layers.windV.data[ci];

  out.time = clock.time;
  out.burningCells = burning;
  out.burnedCells = burned;
  out.burningHa = burning * haPerCell;
  out.burnedHa = burned * haPerCell;
  out.consumedFraction = burnableCells > 0 ? Math.min(1, (burning + burned) / burnableCells) : 0;
  out.crownPassiveCells = passive;
  out.crownActiveCells = active;
  out.maxIntensityKwM = maxI;
  out.frontIntensityKwM = burning > 0 ? sumFrontI / burning : 0;
  out.windU = wu;
  out.windV = wv;
  out.windSpeed = Math.hypot(wu, wv);
  out.temperatureC = env.temperatureC;
  out.relativeHumidity = env.relativeHumidity;
  out.rainRate = env.rainRate;
  out.meanMoisture = moistN > 0 ? byteToFraction(moistSum / moistN) : 0;
  out.lineCutM = line * cellSize;
  out.retardantCells = retardant;
  return out;
}

/** Seconds → `h:mm:ss`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Compass point the wind is blowing **toward** (screen y grows south, so +v is
 * south). Calm (< 0.05 m/s) → `'—'`.
 */
export function compassToward(u: number, v: number): string {
  if (Math.hypot(u, v) < 0.05) return '—';
  // Bearing clockwise from north: atan2(east, north) with north = −v.
  const deg = ((Math.atan2(u, -v) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}
