import { describe, it, expect } from 'vitest';
import { createWorld, FireState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { CaFireModel } from '../src/sim/caFireModel';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import { BasicFuelModel, Fuel } from '../src/sim/basicFuelModel';

function countState(data: Uint8Array, s: number): number {
  let c = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === s) c++;
  return c;
}

describe('CaFireModel', () => {
  it('spreads fire from an ignition into uniform dry fuel', () => {
    const world = createWorld({ width: 32, height: 32, seed: 5 });
    world.layers.fuel.data.fill(Fuel.Grass); // burnable everywhere, moisture 0 = dry
    const sim = new Simulation(world, [
      new UniformWeatherProvider(0, 0),
      new CaFireModel(new BasicFuelModel()),
    ]);

    world.layers.fire.set(16, 16, FireState.Burning);
    expect(countState(world.layers.fire.data, FireState.Burning)).toBe(1);

    sim.run(15, 1);

    const touched =
      countState(world.layers.fire.data, FireState.Burning) +
      countState(world.layers.fire.data, FireState.Burned);
    expect(touched).toBeGreaterThan(1); // the fire grew beyond the seed cell
  });

  it('does not ignite anything across nonburnable fuel', () => {
    const world = createWorld({ width: 8, height: 8, seed: 3 });
    world.layers.fuel.data.fill(Fuel.Nonburnable); // nothing can catch
    const sim = new Simulation(world, [new CaFireModel(new BasicFuelModel())]);

    world.layers.fire.set(4, 4, FireState.Burning);
    sim.run(30, 1);

    // The lone burning cell burns out and ignites no neighbours.
    expect(countState(world.layers.fire.data, FireState.Burning)).toBe(0);
    expect(countState(world.layers.fire.data, FireState.Burned)).toBe(1);
  });

  it('wind biases spread downwind', () => {
    const world = createWorld({ width: 41, height: 41, seed: 11 });
    world.layers.fuel.data.fill(Fuel.Grass);
    const sim = new Simulation(world, [
      new UniformWeatherProvider(2.5, 0), // strong wind toward +x
      new CaFireModel(new BasicFuelModel()),
    ]);

    const cx = 20;
    const cy = 20;
    world.layers.fire.set(cx, cy, FireState.Burning);
    sim.run(12, 1);

    const fire = world.layers.fire.data;
    const burning = (x: number, y: number): boolean =>
      fire[y * world.width + x] !== FireState.Unburned;
    let east = 0;
    let west = 0;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (!burning(x, y)) continue;
        if (x > cx) east++;
        else if (x < cx) west++;
      }
    }
    expect(east).toBeGreaterThan(west); // more spread downwind than upwind
  });
});
