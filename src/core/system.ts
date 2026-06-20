import type { WorldState } from './world';

/**
 * A System runs once per tick and reads/writes only its slice of world state.
 * Systems NEVER call each other — they communicate through the data layers
 * (Handoff §3.1).
 *
 * `step(world, dt)` is the unifying seam verb (Handoff §3.3): abstraction lives
 * at the system/model boundary, never per-cell. Inside `step`, rip through typed
 * arrays tightly.
 */
export interface System {
  readonly name: string;
  step(world: WorldState, dt: number): void;
}
