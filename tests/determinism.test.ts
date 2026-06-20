import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { generateTerrain, ignite, igniteNearestBurnable } from '../src/gen/terrain';
import { CaFireModel } from '../src/sim/caFireModel';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import { BasicFuelModel } from '../src/sim/basicFuelModel';

/** Run the *real* pipeline: terrain gen + uniform weather + CA fire. */
function runScenario(seed: number, steps = 40): WorldState {
  const world = createWorld({ width: 48, height: 48, seed });
  generateTerrain(world);
  ignite(world, 24, 24);
  new Simulation(world, [
    new UniformWeatherProvider(1.5, 0.6),
    new CaFireModel(new BasicFuelModel()),
  ]).run(steps, 1);
  return world;
}

describe('end-to-end determinism (real terrain + CA, not a toy system)', () => {
  it('same seed -> byte-for-byte identical fire and elevation', () => {
    const a = runScenario(2024);
    const b = runScenario(2024);
    expect(Array.from(a.layers.fire.data)).toEqual(Array.from(b.layers.fire.data));
    expect(Array.from(a.layers.elevation.data)).toEqual(Array.from(b.layers.elevation.data));
  });

  it('different seeds -> different landscape', () => {
    const a = runScenario(1);
    const b = runScenario(2);
    expect(Array.from(a.layers.elevation.data)).not.toEqual(Array.from(b.layers.elevation.data));
  });
});

describe('default sandbox scenario', () => {
  it('lights a burnable cell near centre and the fire grows', () => {
    const world = createWorld({ width: 128, height: 128, seed: 1337 });
    generateTerrain(world);
    expect(igniteNearestBurnable(world, 64, 64)).toBe(true);

    new Simulation(world, [
      new UniformWeatherProvider(1.5, 0.6),
      new CaFireModel(new BasicFuelModel()),
    ]).run(60, 1);

    const fire = world.layers.fire.data;
    let touched = 0;
    for (let i = 0; i < fire.length; i++) {
      if (fire[i] === FireState.Burning || fire[i] === FireState.Burned) touched++;
    }
    expect(touched).toBeGreaterThan(5);
  });
});
