import { describe, it, expect } from 'vitest';
import { createWorld, type WorldState } from '../src/core/world';
import { FuelMoistureSystem } from '../src/sim/fuelMoistureSystem';
import { byteToFraction, fractionToByte } from '../src/core/moisture';
import { equilibriumMoistureFraction } from '../src/sim/emc';

function makeWorld(): WorldState {
  return createWorld({ width: 16, height: 16, seed: 7 });
}

function fillMoisture(world: WorldState, byte: number): void {
  world.layers.moisture.data.fill(byte);
}

describe('FuelMoistureSystem — 1-hr timelag toward EMC', () => {
  it('dries wet fuel down toward the ambient EMC', () => {
    const world = makeWorld();
    fillMoisture(world, 128); // ~50%, well above a dry EMC
    world.env.temperatureC = 25;
    world.env.relativeHumidity = 20; // dry
    world.env.rainRate = 0;

    const sys = new FuelMoistureSystem();
    // Run many hours so the exponential fully settles (exp(−83) ≈ 0).
    for (let s = 0; s < 5000; s++) sys.step(world, 60);

    const expectedByte = fractionToByte(equilibriumMoistureFraction(20, 25));
    expect(world.layers.moisture.data[0]).toBe(expectedByte);
    // sanity: it actually fell a long way from 128
    expect(expectedByte).toBeLessThan(30);
  });

  it('moves monotonically toward EMC and does not overshoot', () => {
    const world = makeWorld();
    const startByte = 20; // ~7.8%, below the humid EMC below
    fillMoisture(world, startByte);
    world.env.temperatureC = 20;
    world.env.relativeHumidity = 90; // humid → EMC well above start
    world.env.rainRate = 0;

    const target = equilibriumMoistureFraction(90, 20);
    const sys = new FuelMoistureSystem();
    let prev = byteToFraction(startByte);
    for (let s = 0; s < 500; s++) {
      sys.step(world, 60);
      const cur = byteToFraction(world.layers.moisture.data[0]);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-9); // non-decreasing toward a higher target
      expect(cur).toBeLessThanOrEqual(target + 1e-6); // never past the target
      prev = cur;
    }
  });

  it('rain wets fuel up toward saturation (can cross a typical Mx)', () => {
    const world = makeWorld();
    fillMoisture(world, 20); // dry
    world.env.rainRate = 5; // mm/hr → wetting branch

    const sys = new FuelMoistureSystem();
    for (let s = 0; s < 2000; s++) sys.step(world, 60);

    const wet = byteToFraction(world.layers.moisture.data[0]);
    expect(wet).toBeCloseTo(0.6, 2); // saturation target
    expect(wet).toBeGreaterThan(0.4); // above the highest Anderson dead Mx → front would halt
  });
});

describe('FuelMoistureSystem — determinism & editor coexistence', () => {
  it('same drivers twice → byte-for-byte identical', () => {
    const run = (): Uint8Array => {
      const world = makeWorld();
      fillMoisture(world, 90);
      world.env.relativeHumidity = 35;
      const sys = new FuelMoistureSystem();
      for (let s = 0; s < 300; s++) sys.step(world, 30);
      return world.layers.moisture.data.slice();
    };
    expect(Array.from(run())).toEqual(Array.from(run()));
  });

  it('adopts an external paint (editor writes the byte layer mid-run)', () => {
    const world = makeWorld();
    fillMoisture(world, 128);
    world.env.temperatureC = 25;
    world.env.relativeHumidity = 20; // dry EMC ≈ byte 11
    world.env.rainRate = 0;

    const sys = new FuelMoistureSystem();
    for (let s = 0; s < 5000; s++) sys.step(world, 60); // converge low
    expect(world.layers.moisture.data[5]).toBeLessThan(30);

    // Editor repaints cell 5 wet; the system must integrate FROM 200, not its stale
    // converged mirror value.
    world.layers.moisture.data[5] = 200;
    sys.step(world, 60);
    expect(world.layers.moisture.data[5]).toBeGreaterThan(190); // barely relaxed from 200
    expect(world.layers.moisture.data[0]).toBeLessThan(30); // untouched cell still dry
  });
});
