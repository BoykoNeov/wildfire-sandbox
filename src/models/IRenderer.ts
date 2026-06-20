import type { WorldState } from '../core/world';

/**
 * Render seam (Handoff §3.3, §2.2): reads world state, draws. Decoupled from the
 * sim — a swappable visualization seam. 2D top-down now; a 3D view could be
 * added later as a pure visualization upgrade touching nothing in the sim.
 */
export interface IRenderer {
  render(world: WorldState): void;
}
