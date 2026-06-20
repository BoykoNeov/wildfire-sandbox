import type { System } from '../core/system';

/**
 * Fire-spread seam (Handoff §3.3). Phase 1: cellular automaton. Later: a CA
 * driven by Rothermel-derived rates, then FARSITE-style wavefront propagation.
 *
 * The seam is `step(world, dt)` (via System) — abstract whole models, not
 * individual cell behaviors. Inside `step`, rip through typed arrays tightly.
 */
export interface IFireModel extends System {}
