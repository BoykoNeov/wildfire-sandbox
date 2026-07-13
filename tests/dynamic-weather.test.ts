import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel, ANDERSON_13, deadFuelBed } from '../src/sim/anderson13';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { DynamicWeatherProvider } from '../src/sim/dynamicWeather';
import { surfaceSpread, ftPerMinToMetersPerSec } from '../src/sim/rothermel';
import { byteToFraction } from '../src/core/moisture';

const FM = 1; // FM1 short grass.
const MOIST_BYTE = 15;

function analyticR0Mps(): number {
  const bed = deadFuelBed(ANDERSON_13.get(FM)!, byteToFraction(MOIST_BYTE));
  return ftPerMinToMetersPerSec(surfaceSpread(bed, { midflameWind: 0, tanSlope: 0 }).rateOfSpread);
}

/** Homogeneous flat FM1 field ignited at the centre. */
function centreLitWorld(cellSize: number, w: number, h: number): WorldState {
  const world = createWorld({ width: w, height: h, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST_BYTE);
  world.layers.fire.set(w >> 1, h >> 1, FireState.Burning);
  return world;
}

/** Ignited extent (cells) from centre along the mid row toward +x (east) / -x (west). */
function extents(world: WorldState): { east: number; west: number } {
  const cx = world.width >> 1;
  const cy = world.height >> 1;
  const lit = (x: number): boolean => world.layers.fire.get(x, cy) !== FireState.Unburned;
  let east = 0;
  for (let x = cx + 1; x < world.width && lit(x); x++) east = x - cx;
  let west = 0;
  for (let x = cx - 1; x >= 0 && lit(x); x--) west = cx - x;
  return { east, west };
}

describe('DynamicWeatherProvider — time-varying wind flips the dangerous flank', () => {
  it('east flank leads under early east wind; west flank overtakes after the shift', () => {
    const R0 = analyticR0Mps();
    const cellSize = 20 * R0; // ~20 ticks per no-wind cell crossing
    const w = 81;
    const h = 81;
    const T = 1200; // wind ramps east → west over [0, T]

    const world = centreLitWorld(cellSize, w, h);
    // Two keyframes: strong east wind at t=0 ramping to strong west wind at t=T.
    // Midway (t=T/2) the mean wind passes through calm and reverses.
    const weather = new DynamicWeatherProvider([
      { time: 0, u: 4, v: 0 },
      { time: T, u: -4, v: 0 },
    ]);
    const sim = new Simulation(world, [weather, new RothermelFireModel(new Anderson13FuelModel())]);

    // Phase A: wind still predominantly east.
    sim.run(T / 2, 1);
    const a = extents(world);
    // Phase B: wind now predominantly west.
    sim.run(T / 2, 1);
    const b = extents(world);

    // While the wind blew east, the east flank ran ahead of the west flank.
    expect(a.east).toBeGreaterThan(a.west);
    // After the reversal, the west flank became the fast one: it gained more ground
    // in phase B than the (now upwind) east flank did.
    const eastGrowth = b.east - a.east;
    const westGrowth = b.west - a.west;
    expect(westGrowth).toBeGreaterThan(eastGrowth);
  });
});

describe('DynamicWeatherProvider — determinism & gust field', () => {
  it('same config twice → byte-for-byte identical fire (own RNG, not world.rng)', () => {
    const run = (): Uint8Array => {
      const world = centreLitWorld(30, 40, 40);
      const weather = new DynamicWeatherProvider([{ time: 0, u: 2, v: 1 }], {
        gust: { seed: 7 },
      });
      new Simulation(world, [weather, new RothermelFireModel(new Anderson13FuelModel())]).run(200, 1);
      return world.layers.fire.data.slice();
    };
    expect(Array.from(run())).toEqual(Array.from(run()));
  });

  it('a gust field is spatially non-uniform (gusts actually vary per cell)', () => {
    const world = createWorld({ width: 32, height: 32, seed: 1, cellSize: 30 });
    const weather = new DynamicWeatherProvider([{ time: 0, u: 3, v: 0 }], {
      gust: { seed: 3, speedAmp: 0.5, dirAmp: 0.5 },
    });
    weather.step(world, 1);

    const u = world.layers.windU.data;
    const v = world.layers.windV.data;
    let minU = Infinity;
    let maxU = -Infinity;
    let anyV = false;
    for (let i = 0; i < u.length; i++) {
      if (u[i] < minU) minU = u[i];
      if (u[i] > maxU) maxU = u[i];
      if (Math.abs(v[i]) > 1e-6) anyV = true;
    }
    expect(maxU - minU).toBeGreaterThan(0.1); // speed varies across the map
    expect(anyV).toBe(true); // direction varies → nonzero cross-wind somewhere
  });

  it('mean-only (no gust) writes a spatially-uniform field', () => {
    const world = createWorld({ width: 16, height: 16, seed: 1, cellSize: 30 });
    new DynamicWeatherProvider([{ time: 0, u: 2.5, v: -1 }]).step(world, 1);
    const u = world.layers.windU.data;
    const v = world.layers.windV.data;
    for (let i = 0; i < u.length; i++) {
      expect(u[i]).toBeCloseTo(2.5, 6);
      expect(v[i]).toBeCloseTo(-1, 6);
    }
  });
});
