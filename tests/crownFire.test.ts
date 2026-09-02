import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import type { System } from '../src/core/system';
import { Anderson13FuelModel } from '../src/sim/anderson13';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { SpottingSystem } from '../src/sim/spottingSystem';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import { DEFAULT_CANOPY_STAND, canopyBulkDensity } from '../src/sim/canopyStand';
import {
  CrownFire,
  activeCrownRos,
  activeCrownThresholdRos,
  crownFractionBurned,
  crownInitiationIntensity,
  evaluateCrownFire,
  type CrownInputs,
  type CrownResult,
} from '../src/sim/crownFire';

/**
 * Crown fire (handoff §2.1 "two coupled surface layers with a transition
 * threshold"). The pure module is pinned against hand-worked Van Wagner (1977)
 * numbers; the integration tests prove the transition changes what the front
 * does — and, just as importantly, that it does NOT fire where it shouldn't.
 */

describe('Van Wagner (1977) criteria — hand-worked', () => {
  it('I_0 for CBH 3 m, FMC 100% = (0.01·3·3050)^1.5 ≈ 875 kW/m', () => {
    expect(crownInitiationIntensity(3, 100)).toBeCloseTo(Math.pow(91.5, 1.5), 6);
    expect(crownInitiationIntensity(3, 100)).toBeCloseTo(875.2, 0);
  });
  it('a higher, moister crown needs a much hotter surface fire', () => {
    expect(crownInitiationIntensity(6, 100)).toBeGreaterThan(2 * crownInitiationIntensity(3, 100));
    expect(crownInitiationIntensity(3, 150)).toBeGreaterThan(crownInitiationIntensity(3, 100));
  });
  it('RAC = 3.0/CBD m/min (0.05 kg/m²/s critical mass flow)', () => {
    expect(activeCrownThresholdRos(0.1)).toBeCloseTo(30, 9);
    expect(activeCrownThresholdRos(0.25)).toBeCloseTo(12, 9);
    expect(activeCrownThresholdRos(0)).toBe(Infinity);
  });
  it('Rothermel 1991: R_active = 3.34 · R_FM10', () => {
    expect(activeCrownRos(10)).toBeCloseTo(33.4, 9);
  });
});

describe('crown fraction burned (Van Wagner 1993 / Finney 1998 form)', () => {
  it('is 0 below initiation, 0.9 at 90% of the way to RAC, monotonic, ≤ 1', () => {
    expect(crownFractionBurned(1, 2, 20)).toBe(0);
    // a_c = −ln(0.1)/(0.9·(RAC − R_init)) ⇒ CFB = 0.9 at R_init + 0.9·(RAC − R_init).
    expect(crownFractionBurned(2 + 0.9 * 18, 2, 20)).toBeCloseTo(0.9, 9);
    expect(crownFractionBurned(20, 2, 20)).toBeGreaterThan(0.9);
    let prev = 0;
    for (let r = 2; r <= 40; r += 2) {
      const c = crownFractionBurned(r, 2, 20);
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c).toBeLessThanOrEqual(1);
      prev = c;
    }
  });
  it('a stand whose RAC is at/below the initiation rate crowns fully once initiated', () => {
    expect(crownFractionBurned(5, 5, 4)).toBe(1);
  });
});

describe('evaluateCrownFire — the transition', () => {
  const base: CrownInputs = {
    surfaceIntensity: 0,
    surfaceRos: 5, // m/min
    fm10Ros: 5, // m/min → R_active = 16.7 m/min
    cbd: 0.2, // RAC = 15 m/min
    baseHeightM: 3,
    standHeightM: 20,
    foliarMoisturePct: 100,
  };
  const out = (): CrownResult => ({ type: CrownFire.None, cfb: 0, ros: 0, intensity: 0 });

  it('below I_0 the surface values pass through untouched', () => {
    const r = evaluateCrownFire({ ...base, surfaceIntensity: 500 }, out());
    expect(r.type).toBe(CrownFire.None);
    expect(r.ros).toBe(5);
    expect(r.intensity).toBe(500);
    expect(r.cfb).toBe(0);
  });
  it('above I_0 with R_active ≥ RAC → ACTIVE: faster and hotter than the surface fire', () => {
    const r = evaluateCrownFire({ ...base, surfaceIntensity: 2000 }, out());
    expect(r.type).toBe(CrownFire.Active);
    expect(r.cfb).toBeGreaterThan(0);
    expect(r.ros).toBeGreaterThan(5);
    expect(r.intensity).toBeGreaterThan(2000);
  });
  it('above I_0 but R_active < RAC → PASSIVE (torching), still above surface values', () => {
    const r = evaluateCrownFire({ ...base, surfaceIntensity: 2000, cbd: 0.05 }, out()); // RAC = 60
    expect(r.type).toBe(CrownFire.Passive);
    expect(r.ros).toBeGreaterThanOrEqual(5);
    expect(r.intensity).toBeGreaterThan(2000);
  });
  it('no canopy → never crowns however hot the surface fire', () => {
    const r = evaluateCrownFire({ ...base, surfaceIntensity: 1e5, cbd: 0 }, out());
    expect(r.type).toBe(CrownFire.None);
  });
});

// ---------------------------------------------------------------------------

const FM10 = 10;
const DRY = 10; // ≈ 4% dead moisture
const TIMBER_CANOPY = 200;

function timberWorld(canopy: number, cellSize = 30, width = 60, height = 5): WorldState {
  const world = createWorld({ width, height, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM10);
  world.layers.moisture.data.fill(DRY);
  world.layers.canopy.data.fill(canopy);
  for (let y = 0; y < height; y++) world.layers.fire.set(0, y, FireState.Burning);
  return world;
}

function frontColumn(world: WorldState): number {
  let front = 0;
  for (let x = 0; x < world.width; x++) {
    if (world.layers.fire.get(x, 2) !== FireState.Unburned) front = x;
  }
  return front;
}

function crownCounts(world: WorldState): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  for (const v of world.layers.crown.data) c[v]++;
  return c;
}

describe('RothermelFireModel crown-fire integration', () => {
  const WIND = 8; // m/s midflame — a hard, dry, windy day in timber
  const STEPS = 900;

  it('dry timber under strong wind crowns: the front outruns a surface-only model and the crown layer records it', () => {
    const crowning = timberWorld(TIMBER_CANOPY);
    new Simulation(crowning, [
      new UniformWeatherProvider(WIND, 0),
      new RothermelFireModel(new Anderson13FuelModel(), { crownFire: true }),
    ]).run(STEPS, 1);

    const surfaceOnly = timberWorld(TIMBER_CANOPY);
    new Simulation(surfaceOnly, [
      new UniformWeatherProvider(WIND, 0),
      new RothermelFireModel(new Anderson13FuelModel(), { crownFire: false }),
    ]).run(STEPS, 1);

    expect(frontColumn(crowning)).toBeGreaterThan(frontColumn(surfaceOnly) * 1.5);
    const [, passive, active] = crownCounts(crowning);
    expect(active + passive).toBeGreaterThan(5);
    expect(active).toBeGreaterThan(0); // CBD 0.196 → RAC 15 m/min: a running crown fire
    expect(crownCounts(surfaceOnly)).toEqual([surfaceOnly.width * surfaceOnly.height, 0, 0]);
    // Crown-ignited cells carry the added canopy heat.
    let maxI = 0;
    for (const v of crowning.layers.intensity.data) maxI = Math.max(maxI, v);
    let maxS = 0;
    for (const v of surfaceOnly.layers.intensity.data) maxS = Math.max(maxS, v);
    expect(maxI).toBeGreaterThan(maxS);
  });

  it('the same fire under NO canopy never crowns and is byte-identical to the surface-only model', () => {
    const a = timberWorld(0);
    new Simulation(a, [
      new UniformWeatherProvider(WIND, 0),
      new RothermelFireModel(new Anderson13FuelModel(), { crownFire: true }),
    ]).run(STEPS, 1);
    const b = timberWorld(0);
    new Simulation(b, [
      new UniformWeatherProvider(WIND, 0),
      new RothermelFireModel(new Anderson13FuelModel(), { crownFire: false }),
    ]).run(STEPS, 1);
    expect(Array.from(a.layers.fire.data)).toEqual(Array.from(b.layers.fire.data));
    expect(crownCounts(a)[0]).toBe(a.width * a.height);
  });

  it('a high, moist crown (CBH 12 m, FMC 150%) does not initiate under a fire that crowns a low dry one', () => {
    const hard = timberWorld(TIMBER_CANOPY);
    new Simulation(hard, [
      new UniformWeatherProvider(WIND, 0),
      new RothermelFireModel(new Anderson13FuelModel(), {
        canopy: { ...DEFAULT_CANOPY_STAND, baseHeightM: 12, foliarMoisturePct: 150 },
      }),
    ]).run(STEPS, 1);
    expect(crownCounts(hard)[0]).toBe(hard.width * hard.height);
  });

  it('a calm day in the same timber stays a surface fire (I_B below I_0)', () => {
    // FM10's calm R0 is ~0.5 m/min, so use 5 m cells to see the front move at all.
    const calm = timberWorld(TIMBER_CANOPY, 5);
    new Simulation(calm, [new RothermelFireModel(new Anderson13FuelModel())]).run(1500, 1);
    expect(frontColumn(calm)).toBeGreaterThan(0);
    expect(crownCounts(calm)[0]).toBe(calm.width * calm.height);
  });

  it('grass never crowns (its canopy byte gives CBD below the crown floor)', () => {
    expect(canopyBulkDensity(10, DEFAULT_CANOPY_STAND)).toBeLessThan(0.02);
    const grass = createWorld({ width: 60, height: 5, seed: 1, cellSize: 30 });
    grass.layers.fuel.data.fill(3); // FM3 tall grass — a hot surface fire
    grass.layers.moisture.data.fill(DRY);
    grass.layers.canopy.data.fill(10);
    for (let y = 0; y < 5; y++) grass.layers.fire.set(0, y, FireState.Burning);
    new Simulation(grass, [
      new UniformWeatherProvider(WIND, 0),
      new RothermelFireModel(new Anderson13FuelModel()),
    ]).run(STEPS, 1);
    expect(frontColumn(grass)).toBeGreaterThan(10);
    expect(crownCounts(grass)[0]).toBe(grass.width * grass.height);
  });

  it('is deterministic: same setup twice → identical fire, intensity and crown layers', () => {
    const run = (): WorldState => {
      const w = timberWorld(TIMBER_CANOPY);
      new Simulation(w, [
        new UniformWeatherProvider(WIND, 0),
        new RothermelFireModel(new Anderson13FuelModel()),
      ]).run(STEPS, 1);
      return w;
    };
    const a = run();
    const b = run();
    expect(Array.from(a.layers.fire.data)).toEqual(Array.from(b.layers.fire.data));
    expect(Array.from(a.layers.crown.data)).toEqual(Array.from(b.layers.crown.data));
    expect(Array.from(a.layers.intensity.data)).toEqual(Array.from(b.layers.intensity.data));
  });
});

describe('spotting reads the crown layer — a crowning source throws more embers', () => {
  /** A held single source at the west edge of a dry, receptive downwind field. */
  function spotCount(seed: number, crownType: number): number {
    const W = 40;
    const H = 9;
    const world = createWorld({ width: W, height: H, seed, cellSize: 30 });
    world.layers.fuel.data.fill(FM10);
    world.layers.moisture.data.fill(DRY);
    world.layers.canopy.data.fill(TIMBER_CANOPY);
    world.layers.windU.data.fill(10);
    const src = 4 * W + 2;
    world.layers.fire.data[src] = FireState.Burning;
    world.layers.crown.data[src] = crownType;
    // Spotting alone (no fire model, so nothing overwrites the stamped crown state);
    // the source is re-stamped Burning each tick as a sustained ember factory.
    const hold: System = {
      name: 'test:hold',
      step(w) {
        w.layers.fire.data[src] = FireState.Burning;
      },
    };
    new Simulation(world, [hold, new SpottingSystem(new Anderson13FuelModel())]).run(120, 1);
    let n = 0;
    for (let i = 0; i < W * H; i++) if (i !== src && world.layers.fire.data[i] !== FireState.Unburned) n++;
    return n;
  }

  it('active crown source ≫ surface source, over a seed sweep', () => {
    let surface = 0;
    let active = 0;
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      surface += spotCount(seed, CrownFire.None);
      active += spotCount(seed, CrownFire.Active);
    }
    expect(active).toBeGreaterThan(surface * 2);
  });
});
