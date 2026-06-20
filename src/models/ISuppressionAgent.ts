import type { System } from '../core/system';

/**
 * Firefighting-capability seam (Handoff §3.3, §4.4): a crew, engine or aircraft.
 * New capabilities = new implementations. Phase 4 work — present as a stub now
 * so later additions are additive, not surgery.
 */
export interface ISuppressionAgent extends System {
  /** Agent-type key for the future agent x fuel-class effectiveness matrix. */
  readonly agentType: string;
}
