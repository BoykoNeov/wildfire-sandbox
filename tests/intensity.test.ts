import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel, ANDERSON_13, deadFuelBed } from '../src/sim/anderson13';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import {
  btuPerFtSecToKwPerM,
  ftPerMinToMetersPerSec,
  kwPerMToBtuPerFtSec,
  metersPerSecToFtPerMin,
  surfaceSpread,
} from '../src/sim/rothermel';
import { byteToFraction } from '../src/core/moisture';

/**
 * The `intensity` output layer: the Rothermel fire model records Byram's fireline
 * intensity (kW/m) of the arriving front on every cell it ignites. This is the
 * observable crown-fire initiation, ember production and the renderer read, so
 * its meaning is pinned here against the pure module's own numbers.
 */

const FM = 1;
const MOIST_BYTE = 15;

function analytic(midflameMps: number): { r0: number; ib: number } {
  const bed = deadFuelBed(ANDERSON_13.get(FM)!, byteToFraction(MOIST_BYTE));
  const r = surfaceSpread(bed, { midflameWind: metersPerSecToFtPerMin(midflameMps), tanSlope: 0 });
  return { r0: ftPerMinToMetersPerSec(r.rateOfSpread), ib: btuPerFtSecToKwPerM(r.firelineIntensity) };
}

function planarWorld(cellSize: number, width = 24, height = 5): WorldState {
  const world = createWorld({ width, height, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST_BYTE);
  for (let y = 0; y < height; y++) world.layers.fire.set(0, y, FireState.Burning);
  return world;
}

describe('unit conversion', () => {
  it('BTU/ft/s ↔ kW/m round-trips and matches the textbook factor (≈3.461)', () => {
    expect(btuPerFtSecToKwPerM(1)).toBeCloseTo(3.4613, 3);
    expect(kwPerMToBtuPerFtSec(btuPerFtSecToKwPerM(123.4))).toBeCloseTo(123.4, 9);
  });
});

describe('intensity layer — written by the Rothermel fire model', () => {
  it('front-ignited cells carry the analytic fireline intensity; unburned cells stay 0', () => {
    const { r0, ib } = analytic(0);
    expect(ib).toBeGreaterThan(0);
    const world = planarWorld(40 * r0);
    new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel())]).run(400, 1);

    const my = world.height >> 1;
    let checked = 0;
    for (let x = 1; x < world.width; x++) {
      const i = my * world.width + x;
      const state = world.layers.fire.data[i];
      const v = world.layers.intensity.data[i];
      if (state === FireState.Unburned) {
        expect(v).toBe(0);
      } else {
        // No wind, no slope, homogeneous bed: every arrival is exactly the analytic I_B.
        expect(v).toBeCloseTo(ib, 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3); // non-vacuous: the front actually moved
  });

  it('an externally-lit cell gets its own head-fire intensity on its first burning tick', () => {
    const { r0, ib } = analytic(0);
    const world = planarWorld(40 * r0);
    // The seed column was set Burning directly (no arriving front) → intensity 0 …
    expect(world.layers.intensity.get(0, 2)).toBe(0);
    new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel())]).step(1);
    // … and after one tick the model has filled in the head-fire value (calm ⇒ = I_B).
    expect(world.layers.intensity.get(0, 2)).toBeCloseTo(ib, 6);
  });

  it('wind raises the recorded intensity downwind of the front', () => {
    const { r0 } = analytic(0);
    const calm = planarWorld(40 * r0);
    new Simulation(calm, [new RothermelFireModel(new Anderson13FuelModel())]).run(300, 1);
    const windy = planarWorld(40 * r0);
    new Simulation(windy, [
      new UniformWeatherProvider(3, 0),
      new RothermelFireModel(new Anderson13FuelModel()),
    ]).run(300, 1);

    const my = 2;
    const calmI = calm.layers.intensity.get(2, my);
    const windyI = windy.layers.intensity.get(2, my);
    expect(calmI).toBeGreaterThan(0);
    expect(windyI).toBeGreaterThan(calmI * 2);
    // And it is the analytic wind-driven value (wind projected fully onto +x).
    expect(windyI).toBeCloseTo(analytic(3).ib, 4);
  });
});
