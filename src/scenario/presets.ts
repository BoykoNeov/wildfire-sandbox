import type { Scenario } from './scenario';

/**
 * Named scenarios (Phase-5b). Each is a teaching unit: the description says what
 * true thing it shows. All are plain data; `loadScenario` builds them. Wind is
 * authored the way the scenario's `windReference` reads it — the original demo
 * keeps its midflame m/s keyframes byte-for-byte; the newer units are authored
 * from reported 20-ft winds and let the wind adjustment factor do the reduction.
 */

const W = 256;
const H = 256;
const C = W >> 1; // map centre

/**
 * The original demo landscape (seed 1337) and its NE → N → NW wind shift, now
 * authored as reported 20-ft winds under the `'open'` reference (the old
 * hand-wired 1.6 m/s "midflame" values gave a front that barely moved in an
 * hour). Same terrain, same story, a watchable pace.
 */
const shiftingWinds: Scenario = {
  id: 'shifting-winds',
  name: 'Shifting winds',
  description:
    'A mixed grass/brush/timber unit on a dry afternoon. The wind swings from NE through calm to NW ' +
    'over 30 minutes — whichever flank was safe becomes the dangerous one. Anchor your line.',
  seed: 1337,
  width: W,
  height: H,
  fireModel: { windReference: 'open' },
  weather: {
    wind: [
      { time: 0, u: 5.6, v: 2.4 }, // ~6 m/s blowing toward the ESE
      { time: 900, u: 0.6, v: 4.8 }, // swinging to blow south…
      { time: 1800, u: -5.2, v: 3.6 }, // …settling toward the SW
    ],
    ambient: { temperatureC: 30, relativeHumidity: 20, rainRate: 0 },
    gust: { speedAmp: 0.4, dirAmp: 0.35 },
  },
  ignitions: 'center',
  agents: {
    crew: { x: C, y: C + 24 },
    engine: { x: C - 40, y: C + 24 },
    aircraft: { x: C - 40, y: C - 40 },
  },
};

/** Cured grass, hot and windy: the fastest surface fire there is. */
const grassValley: Scenario = {
  id: 'grass-valley',
  name: 'Grass valley',
  description:
    'Cured tall grass (FM3) under a steady 9 m/s afternoon wind at 12% humidity. A grass fire is ' +
    'fast, wide and shallow: it flanks a point attack instantly, but a line anchored to the water holds it. ' +
    'Water drops work here — there is no crown to hide in.',
  seed: 4242,
  width: W,
  height: H,
  terrain: { waterLevel: 0.24, rockLevel: 0.9, grassBand: 0.7, brushBand: 0.9, moistureMin: 6, moistureMax: 30 },
  fuelMapping: { grass: 3, brush: 5, timber: 9 },
  fireModel: { windReference: 'open', liveMoisture: 0.6 },
  weather: {
    wind: [
      { time: 0, u: 6.4, v: -6.4 }, // 9 m/s 20-ft wind blowing toward the NE (screen-up is −y)
      { time: 3600, u: 8.0, v: -6.0 },
    ],
    ambient: { temperatureC: 35, relativeHumidity: 12, rainRate: 0 },
    gust: { speedAmp: 0.3, dirAmp: 0.25 },
  },
  ignitions: [{ x: C - 60, y: C + 50 }],
  agents: {
    crew: { x: C - 20, y: C + 10 },
    engine: { x: C - 70, y: C + 70, refillX: C - 90, refillY: C + 90 },
    aircraft: { x: C + 80, y: C + 90 },
  },
  timeScale: 60,
};

/** Dry timber, low crowns, a rising wind: the crown-fire and spotting unit. */
const timberCrownRun: Scenario = {
  id: 'timber-crown-run',
  name: 'Timber crown run',
  description:
    'A dense conifer unit (FM10 litter under a 2 m crown base) on a 33 °C, 15% RH day with the wind ' +
    'rising from 8 to 14 m/s. Surface fire torches, then runs as an active crown fire several times faster, ' +
    'throwing embers far downwind. Aerial drops on the run are near-useless; pre-treat ahead of it and cut line to rock.',
  seed: 9001,
  width: W,
  height: H,
  terrain: { waterLevel: 0.22, rockLevel: 0.88, grassBand: 0.15, brushBand: 0.35, moistureMin: 5, moistureMax: 22 },
  fuelMapping: { grass: 2, brush: 4, timber: 10 },
  fireModel: {
    windReference: 'open',
    liveMoisture: 0.8,
    canopy: { standHeightM: 22, crownRatio: 0.6, baseHeightM: 2, maxBulkDensityKgM3: 0.16, foliarMoisturePct: 90 },
  },
  weather: {
    wind: [
      { time: 0, u: 8.0, v: 0 }, // 8 m/s toward the east
      { time: 1500, u: 12.0, v: -3.0 },
      { time: 3000, u: 14.0, v: -4.0 },
    ],
    ambient: { temperatureC: 33, relativeHumidity: 15, rainRate: 0 },
    gust: { speedAmp: 0.35, dirAmp: 0.3 },
  },
  ignitions: [{ x: C - 80, y: C + 10 }],
  agents: {
    crew: { x: C, y: C - 30 },
    engine: { x: C - 90, y: C + 60 },
    aircraft: { x: C - 90, y: C - 90 },
  },
  timeScale: 60,
};

/** A running brush fire met by a weather front: humidity recovery, then rain. */
const rainFront: Scenario = {
  id: 'rain-front',
  name: 'Rain front',
  description:
    'Brush and grass burning under a warm westerly. At 40 minutes a front arrives: humidity climbs, the ' +
    'temperature drops and rain falls for half an hour. Watch dead-fuel moisture cross the extinction line ' +
    'and the front stall — then dry back out. Water buys time; only fuel removal is permanent.',
  seed: 777,
  width: W,
  height: H,
  terrain: { waterLevel: 0.28, rockLevel: 0.85, grassBand: 0.45, brushBand: 0.85 },
  fuelMapping: { grass: 1, brush: 5, timber: 9 },
  fireModel: { windReference: 'open', liveMoisture: 0.9 },
  weather: {
    wind: [
      { time: 0, u: 7.0, v: 1.0 },
      { time: 2400, u: 5.0, v: 4.0 }, // the front veers the wind…
      { time: 4800, u: 3.0, v: 3.0 }, // …and eases it
    ],
    ambient: [
      { time: 0, temperatureC: 31, relativeHumidity: 22, rainRate: 0 },
      { time: 2400, temperatureC: 29, relativeHumidity: 30, rainRate: 0 }, // 40 min: front arriving
      { time: 3000, temperatureC: 22, relativeHumidity: 85, rainRate: 4 }, // 50 min: rain
      { time: 4800, temperatureC: 21, relativeHumidity: 88, rainRate: 4 }, // 80 min: still raining
      { time: 5400, temperatureC: 23, relativeHumidity: 60, rainRate: 0 }, // 90 min: clearing
      { time: 9000, temperatureC: 27, relativeHumidity: 35, rainRate: 0 }, // drying back out
    ],
    gust: { speedAmp: 0.3, dirAmp: 0.3 },
  },
  ignitions: [{ x: C - 50, y: C }],
  agents: {
    crew: { x: C + 30, y: C - 20 },
    engine: { x: C - 60, y: C + 40 },
    aircraft: { x: C + 60, y: C + 70 },
  },
  timeScale: 120,
};

/** All presets, in menu order. */
export const PRESETS: ReadonlyArray<Scenario> = [shiftingWinds, grassValley, timberCrownRun, rainFront];

/** The preset the sandbox opens on. */
export const DEFAULT_PRESET_ID = shiftingWinds.id;

/** Look a preset up by id; `undefined` if unknown. */
export function findPreset(id: string): Scenario | undefined {
  return PRESETS.find((p) => p.id === id);
}
