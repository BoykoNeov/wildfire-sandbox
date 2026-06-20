import type { System } from './system';
import type { WorldState } from './world';

/**
 * Headless simulation engine (Handoff §3.2): steps without drawing. Rendering
 * reads world state but never drives the sim — which is what makes every system
 * verifiable in isolation and scenarios reproducible.
 */
export class Simulation {
  constructor(
    readonly world: WorldState,
    readonly systems: System[],
  ) {}

  /** Advance the world by one tick of `dt` seconds. */
  step(dt: number): void {
    for (const system of this.systems) {
      system.step(this.world, dt);
    }
    this.world.clock.tick += 1;
    this.world.clock.time += dt;
  }

  /** Advance `steps` ticks of `dt` seconds each (headless batch). */
  run(steps: number, dt: number): void {
    for (let i = 0; i < steps; i++) {
      this.step(dt);
    }
  }
}
