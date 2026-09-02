import { describe, it, expect } from 'vitest';
import { createWorld, FireState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel } from '../src/sim/anderson13';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import { Fuel } from '../src/sim/basicFuelModel';
import { CrownFire } from '../src/sim/crownFire';
import { computeStats, compassToward, formatDuration } from '../src/sim/stats';

describe('computeStats on a hand-built world', () => {
  it('counts exactly what is in the layers', () => {
    const world = createWorld({ width: 10, height: 10, seed: 1, cellSize: 30 });
    const L = world.layers;
    L.fuel.data.fill(Fuel.Grass);
    L.moisture.data.fill(51); // 20%
    L.fire.set(1, 1, FireState.Burning);
    L.fire.set(2, 1, FireState.Burning);
    L.fire.set(3, 1, FireState.Burned);
    L.intensity.set(1, 1, 100);
    L.intensity.set(2, 1, 300);
    L.intensity.set(3, 1, 900);
    L.crown.set(3, 1, CrownFire.Active);
    L.crown.set(2, 1, CrownFire.Passive);
    L.fuel.set(5, 5, Fuel.CutLine);
    L.fuel.set(6, 5, Fuel.CutLine);
    L.fuel.set(0, 0, Fuel.Nonburnable);
    L.retardant.set(7, 7, 120);
    L.windU.set(5, 5, 3);
    L.windV.set(5, 5, -4);
    world.env.temperatureC = 31;
    world.env.relativeHumidity = 18;
    world.env.rainRate = 0;
    world.clock.time = 3725;

    const s = computeStats(world, 97);
    expect(s.time).toBe(3725);
    expect(s.burningCells).toBe(2);
    expect(s.burnedCells).toBe(1);
    expect(s.burningHa).toBeCloseTo(0.18, 9);
    expect(s.burnedHa).toBeCloseTo(0.09, 9);
    expect(s.consumedFraction).toBeCloseTo(3 / 97, 9);
    expect(s.crownActiveCells).toBe(1);
    expect(s.crownPassiveCells).toBe(1);
    expect(s.maxIntensityKwM).toBe(900);
    expect(s.frontIntensityKwM).toBe(200);
    expect(s.windU).toBe(3);
    expect(s.windV).toBe(-4);
    expect(s.windSpeed).toBe(5);
    expect(s.temperatureC).toBe(31);
    expect(s.relativeHumidity).toBe(18);
    expect(s.meanMoisture).toBeCloseTo(0.2, 9);
    expect(s.lineCutM).toBe(60);
    expect(s.retardantCells).toBe(1);
  });

  it('is allocation-friendly: reuses the passed record', () => {
    const world = createWorld({ width: 4, height: 4, seed: 1 });
    const out = computeStats(world, 16);
    const again = computeStats(world, 16, out);
    expect(again).toBe(out);
  });
});

describe('computeStats over a live run', () => {
  it('burned area rises monotonically and consumption follows', () => {
    const world = createWorld({ width: 40, height: 10, seed: 1, cellSize: 2 });
    world.layers.fuel.data.fill(1);
    world.layers.moisture.data.fill(15);
    for (let y = 0; y < 10; y++) world.layers.fire.set(0, y, FireState.Burning);
    const sim = new Simulation(world, [
      new UniformWeatherProvider(2, 0),
      new RothermelFireModel(new Anderson13FuelModel()),
    ]);
    let prev = computeStats(world, 390);
    for (let k = 0; k < 6; k++) {
      sim.run(30, 1);
      const s = computeStats(world, 390);
      expect(s.burnedCells).toBeGreaterThanOrEqual(prev.burnedCells);
      expect(s.consumedFraction).toBeGreaterThanOrEqual(prev.consumedFraction);
      prev = s;
    }
    expect(prev.burnedCells).toBeGreaterThan(10);
    expect(prev.maxIntensityKwM).toBeGreaterThan(0);
  });
});

describe('formatters', () => {
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0:00:00');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(59.9)).toBe('0:00:59');
  });
  it('compassToward uses screen coordinates (y grows south)', () => {
    expect(compassToward(0, -1)).toBe('N');
    expect(compassToward(1, 0)).toBe('E');
    expect(compassToward(0, 1)).toBe('S');
    expect(compassToward(-1, 0)).toBe('W');
    expect(compassToward(1, -1)).toBe('NE');
    expect(compassToward(0, 0)).toBe('—');
  });
});
