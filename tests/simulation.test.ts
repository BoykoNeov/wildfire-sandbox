import { describe, it, expect } from 'vitest';
import { createWorld, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import type { System } from '../src/core/system';

/**
 * The architecture proof. One determinism test exercises every non-negotiable at
 * once: world/systems split, headless stepping, the seeded RNG and typed-array
 * layers — with no fire model needed. If these pass, the foundation is sound.
 */
describe('Simulation (architecture proof)', () => {
  it('runs systems through the data layers and advances the clock', () => {
    const world = createWorld({ width: 8, height: 8, seed: 1 });
    // A trivial system that only writes a layer — it never touches other systems.
    const writer: System = {
      name: 'test:writer',
      step(w: WorldState) {
        w.layers.moisture.data[0] += 1;
      },
    };
    const sim = new Simulation(world, [writer]);
    sim.run(5, 1);

    expect(world.clock.tick).toBe(5);
    expect(world.clock.time).toBe(5);
    expect(world.layers.moisture.data[0]).toBe(5);
  });

  it('is byte-for-byte reproducible: same seed -> identical layers', () => {
    const build = (): Uint8Array => {
      const world = createWorld({ width: 16, height: 16, seed: 99 });
      // A stochastic system: stir the moisture layer through the seeded RNG.
      const stir: System = {
        name: 'test:stir',
        step(w: WorldState) {
          const i = w.rng.int(w.width * w.height);
          w.layers.moisture.data[i] = w.rng.int(256);
        },
      };
      new Simulation(world, [stir]).run(50, 1);
      return world.layers.moisture.data;
    };

    expect(Array.from(build())).toEqual(Array.from(build()));
  });
});
