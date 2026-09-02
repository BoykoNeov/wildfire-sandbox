import { describe, it, expect } from 'vitest';
import { createWorld, FireState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { generateTerrain, igniteNearestBurnable } from '../src/gen/terrain';
import { TerrainFuelModel } from '../src/sim/terrainFuelModel';
import { DynamicWeatherProvider } from '../src/sim/dynamicWeather';
import { FuelMoistureSystem } from '../src/sim/fuelMoistureSystem';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { SpottingSystem } from '../src/sim/spottingSystem';
import { loadScenario, type Scenario } from '../src/scenario/scenario';
import { PRESETS, findPreset, DEFAULT_PRESET_ID } from '../src/scenario/presets';
import { CrownFire } from '../src/sim/crownFire';

/**
 * Phase-5b: scenarios are plain data + one loader. Loading a preset twice must
 * give byte-identical worlds and runs (the reproducibility promise); the default
 * preset must match the hand-wired pipeline `main.ts` used to build; and every
 * preset must actually burn.
 */

/** A small stand-in for the presets so the run loop stays fast. */
const tiny: Scenario = {
  id: 'tiny',
  name: 'Tiny',
  description: 'test',
  seed: 1337,
  width: 96,
  height: 96,
  weather: {
    wind: [
      { time: 0, u: 1.6, v: 0.7 },
      { time: 900, u: 0.2, v: 1.4 },
    ],
    ambient: { temperatureC: 30, relativeHumidity: 20, rainRate: 0 },
    gust: { speedAmp: 0.4, dirAmp: 0.35 },
  },
  ignitions: 'center',
};

function fireSnapshot(s: Scenario, steps: number): Uint8Array {
  const { sim, world } = loadScenario(s);
  sim.run(steps, 1);
  return world.layers.fire.data.slice();
}

describe('loadScenario', () => {
  it('loading twice → byte-identical terrain and run', () => {
    const a = loadScenario(tiny);
    const b = loadScenario(tiny);
    expect(Array.from(a.world.layers.elevation.data)).toEqual(Array.from(b.world.layers.elevation.data));
    expect(Array.from(a.world.layers.fuel.data)).toEqual(Array.from(b.world.layers.fuel.data));
    expect(Array.from(fireSnapshot(tiny, 300))).toEqual(Array.from(fireSnapshot(tiny, 300)));
  });

  it('matches the equivalent hand-wired pipeline exactly', () => {
    const world = createWorld({ width: tiny.width, height: tiny.height, seed: tiny.seed });
    generateTerrain(world);
    igniteNearestBurnable(world, tiny.width >> 1, tiny.height >> 1);
    const fuel = new TerrainFuelModel();
    new Simulation(world, [
      new DynamicWeatherProvider(tiny.weather.wind, {
        temperatureC: 30,
        relativeHumidity: 20,
        rainRate: 0,
        gust: { seed: tiny.seed, speedAmp: 0.4, dirAmp: 0.35 },
      }),
      new FuelMoistureSystem(),
      new RothermelFireModel(fuel),
      new SpottingSystem(fuel),
    ]).run(300, 1);
    expect(Array.from(fireSnapshot(tiny, 300))).toEqual(Array.from(world.layers.fire.data));
  });

  it('counts the burnable landscape at load and wires agents only when asked', () => {
    const l = loadScenario(tiny);
    expect(l.burnableCells).toBeGreaterThan(0);
    expect(l.burnableCells).toBeLessThan(tiny.width * tiny.height);
    expect(l.crew).toBeNull();
    expect(l.engine).toBeNull();
    expect(l.aircraft).toBeNull();
    expect(l.systems.map((s) => s.name)).toEqual([
      'weather:dynamic',
      'moisture:timelag-emc',
      'fire:rothermel',
      'fire:spotting',
    ]);

    const withAgents = loadScenario({
      ...tiny,
      agents: { crew: { x: 10, y: 10 }, engine: { x: 12, y: 10 }, aircraft: { x: 5, y: 5 } },
    });
    expect(withAgents.crew).not.toBeNull();
    expect(withAgents.systems.map((s) => s.name)).toEqual([
      'weather:dynamic',
      'moisture:timelag-emc',
      'suppression:hand-crew',
      'suppression:engine',
      'suppression:air-tanker',
      'suppression:retardant-field',
      'fire:rothermel',
      'fire:spotting',
    ]);
  });

  it('explicit ignitions light one burnable cell at/beside each point', () => {
    const l = loadScenario({ ...tiny, ignitions: [{ x: 3, y: 4 }, { x: 50, y: 60 }] });
    const fire = l.world.layers.fire.data;
    const fuel = l.world.layers.fuel.data;
    let burning = 0;
    for (let i = 0; i < fire.length; i++) {
      if (fire[i] !== FireState.Burning) continue;
      burning++;
      expect(fuel[i]).not.toBe(0); // never a black speck on water/rock
    }
    expect(burning).toBe(2);
  });
});

/**
 * Presets are authored at 256²; terrain noise is sampled in normalized
 * coordinates, so a half-size world is the SAME landscape at half resolution and
 * scaled ignitions land on the same ground. Agents are dropped (they take orders
 * only from the browser / exporter anyway).
 */
function shrink(p: Scenario, size = 128): Scenario {
  const k = size / p.width;
  return {
    ...p,
    width: size,
    height: Math.round(p.height * k),
    ignitions:
      p.ignitions === 'center'
        ? 'center'
        : p.ignitions.map((c) => ({ x: Math.round(c.x * k), y: Math.round(c.y * k) })),
    agents: undefined,
  };
}

describe('presets', () => {
  it('have unique ids and the default exists', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findPreset(DEFAULT_PRESET_ID)).toBeDefined();
    expect(findPreset('nope')).toBeUndefined();
  });

  for (const p of PRESETS) {
    it(`"${p.id}" loads and its fire grows`, () => {
      const l = loadScenario(shrink(p));
      expect(l.burnableCells).toBeGreaterThan(1000);
      l.sim.run(900, 1);
      let touched = 0;
      for (const v of l.world.layers.fire.data) if (v !== FireState.Unburned) touched++;
      expect(touched).toBeGreaterThan(3);
    });
  }

  it('the timber crown-run unit actually crowns', { timeout: 30000 }, () => {
    const l = loadScenario(shrink(findPreset('timber-crown-run')!));
    l.sim.run(2400, 1);
    let crowning = 0;
    for (const v of l.world.layers.crown.data) if (v !== CrownFire.None) crowning++;
    expect(crowning).toBeGreaterThan(20);
  });

  it('the rain front pushes dead-fuel moisture up after the rain arrives', { timeout: 30000 }, () => {
    const l = loadScenario(shrink(findPreset('rain-front')!, 64));
    const mean = (): number => {
      let s = 0;
      const m = l.world.layers.moisture.data;
      for (let i = 0; i < m.length; i++) s += m[i];
      return s / m.length;
    };
    l.sim.run(2400, 1); // dry, warm: fuels dried toward EMC
    const before = mean();
    expect(l.world.env.rainRate).toBe(0);
    l.sim.run(2400, 1); // through the rain
    expect(l.world.env.rainRate).toBeGreaterThan(0);
    expect(mean()).toBeGreaterThan(before + 20);
  });
});
