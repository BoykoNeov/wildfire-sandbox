import { describe, it, expect } from 'vitest';
import { createWorld, FireState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { generateTerrain, igniteNearestBurnable } from '../src/gen/terrain';
import { TerrainFuelModel } from '../src/sim/terrainFuelModel';
import { DynamicWeatherProvider } from '../src/sim/dynamicWeather';
import { FuelMoistureSystem } from '../src/sim/fuelMoistureSystem';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { SpottingSystem } from '../src/sim/spottingSystem';
import {
  loadScenario,
  scaleScenario,
  MIN_SCENARIO_SIZE,
  MAX_SCENARIO_SIZE,
  type Scenario,
} from '../src/scenario/scenario';
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
  return { ...scaleScenario(p, size), agents: undefined };
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
      // 1800 s, not 900: since Phase 8 a *point* ignition develops more slowly,
      // because only the head ray runs at the head rate and the rest of the
      // ellipse is a fraction of it. "shifting-winds" — one 30 m cell of
      // canopy-sheltered fuel — sits right at the edge of this gate at 900 s
      // (it reaches ~330 burned cells by t = 3000). Giving every preset twice
      // the clock keeps the assertion itself untouched.
      l.sim.run(1800, 1);
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

  it('the timber crown run reproduces its recorded golden hash', { timeout: 30000 }, () => {
    // A whole-run golden for the MOUNTED pipeline (the determinism test's golden
    // pins the Phase-1 CA reference instead). Any change that claims to be
    // byte-identical — a cache, a compaction, a reordered sweep — has to keep
    // this number. If a change deliberately alters the physics, recompute it and
    // say so in the commit.
    //
    // Recomputed in Phase 8: the elliptical spread law (`spreadShape:
    // 'elliptical'`, now the default) changes every direction but the head, so
    // this run is deliberately a different run. Previous value: 1457051880.
    //
    // Recomputed again in Phase 8b: the 16-ray template (`spreadTemplate:
    // 'template16'`, now the default) adds the knight rays and gives every ray
    // its own arrival accumulator, which changes the front's shape and its
    // arrival order. Previous value: 382468332 — still reachable, byte-for-byte,
    // as `spreadTemplate: 'ring8'`.
    //
    // Recomputed again in Phase 9: this preset now states its 10-hr / 100-hr dead
    // moisture (7% / 10%) instead of letting the coarse classes silently inherit
    // the fine moisture byte, so its heavy fuel is honestly wetter than its
    // needles and the stand is slightly less keen to torch (FM10 fireline
    // intensity −3.6% at 3% fine moisture). Previous value: 2410933397 — reachable
    // by dropping the two `dead*hMoisture` fields from the preset.
    const l = loadScenario(shrink(findPreset('timber-crown-run')!));
    l.sim.run(1200, 1);
    const { fire, intensity, crown } = l.world.layers;
    let h = 0x811c9dc5; // FNV-1a over fire, then the intensity bytes, then crown
    const mix = (v: number): void => {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
    };
    for (let i = 0; i < fire.data.length; i++) mix(fire.data[i]);
    for (let i = 0; i < intensity.data.length; i++) {
      const kw = Math.round(intensity.data[i]);
      mix(kw);
      mix(kw >>> 8);
      mix(kw >>> 16);
    }
    for (let i = 0; i < crown.data.length; i++) mix(crown.data[i]);
    expect(h >>> 0).toBe(4181824974);
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

/**
 * Phase-7 item D — `?size=` re-authors a preset for a bigger square map. The
 * whole feature rests on one property of the terrain generator: it samples its
 * value noise in *normalized* coordinates, so a seed draws the same landscape at
 * any size. That is what makes scaling cell coordinates the correct (and
 * sufficient) transform, and it is the first thing tested here.
 */
describe('scaleScenario', () => {
  const preset = findPreset('grass-valley')!; // the one preset with a refill point

  it('draws the same landscape at any size, which is why coordinates just scale', () => {
    const small = createWorld({ width: 256, height: 256, seed: 4242 });
    generateTerrain(small);
    const big = createWorld({ width: 512, height: 512, seed: 4242 });
    generateTerrain(big);
    // Sample the whole map, not a lucky corner. `u = x/(width-1)` is a half-cell
    // off between the two grids, so allow a few metres of a 0-1000 m range.
    let worst = 0;
    for (let y = 0; y < 256; y += 7) {
      for (let x = 0; x < 256; x += 7) {
        const a = small.layers.elevation.data[y * 256 + x];
        const b = big.layers.elevation.data[2 * y * 512 + 2 * x];
        worst = Math.max(worst, Math.abs(a - b));
      }
    }
    expect(worst).toBeLessThan(20);
  });

  it('scales every authored cell coordinate, units included', () => {
    const s = scaleScenario(preset, 512);
    expect(s.width).toBe(512);
    expect(s.height).toBe(512);
    const src = preset.ignitions as { x: number; y: number }[];
    expect(s.ignitions).toEqual(src.map((c) => ({ x: c.x * 2, y: c.y * 2 })));
    expect(s.agents!.crew).toEqual({ x: preset.agents!.crew!.x * 2, y: preset.agents!.crew!.y * 2 });
    const e = preset.agents!.engine!;
    expect(s.agents!.engine).toMatchObject({
      x: e.x * 2,
      y: e.y * 2,
      refillX: e.refillX! * 2,
      refillY: e.refillY! * 2,
    });
    expect(s.agents!.aircraft).toMatchObject({
      x: preset.agents!.aircraft!.x * 2,
      y: preset.agents!.aircraft!.y * 2,
    });
  });

  it('leaves everything that is not a cell coordinate alone', () => {
    const s = scaleScenario(preset, 512);
    expect(s.seed).toBe(preset.seed);
    expect(s.cellSize).toBe(preset.cellSize); // a cell is still 30 m: MORE ground, not finer
    expect(s.terrain).toEqual(preset.terrain);
    expect(s.weather).toEqual(preset.weather);
    expect(s.timeScale).toBe(preset.timeScale);
    // Speeds are cells/second and drop radii are cells, so at an unchanged cell
    // size they already mean the same thing — they must NOT be rescaled.
    expect(s.agents!.engine!.speed).toBe(preset.agents!.engine!.speed);
    expect(s.agents!.aircraft!.dropRadius).toBe(preset.agents!.aircraft!.dropRadius);
  });

  it('is the identity at the authored size, and keeps `center` central', () => {
    expect(scaleScenario(preset, preset.width)).toBe(preset);
    const centred = scaleScenario(findPreset('shifting-winds')!, 384);
    expect(centred.ignitions).toBe('center');
    expect(centred.agents!.crew).toBeDefined();
  });

  it('keeps scaled points inside the map, and survives a preset with no units', () => {
    const edge: Scenario = {
      ...preset,
      ignitions: [{ x: 255, y: 255 }],
      agents: undefined,
    };
    const s = scaleScenario(edge, MIN_SCENARIO_SIZE);
    expect(s.agents).toBeUndefined();
    const [c] = s.ignitions as { x: number; y: number }[];
    expect(c.x).toBeLessThan(MIN_SCENARIO_SIZE);
    expect(c.y).toBeLessThan(MIN_SCENARIO_SIZE);
    expect(MAX_SCENARIO_SIZE).toBeGreaterThan(MIN_SCENARIO_SIZE);
  });

  it('loads and burns on the bigger map', { timeout: 30000 }, () => {
    const l = loadScenario(scaleScenario(shrink(preset, 96), 192));
    expect(l.world.width).toBe(192);
    l.sim.run(1200, 1);
    let burned = 0;
    const f = l.world.layers.fire.data;
    for (let i = 0; i < f.length; i++) if (f[i] !== FireState.Unburned) burned++;
    expect(burned).toBeGreaterThan(50);
  });
});
