/**
 * The unifying entity abstraction (Handoff §3.4). A WUI structure and an
 * industrial vessel are the SAME thing: material properties + ignition/burn
 * state machine + suppression effectiveness keyed to agent type.
 *
 * Phase 1: present but empty, so later phases (Structures/WUI, Industrial) are
 * additive, not surgery. Do not delete this stub.
 */
export type EntityState = 'intact' | 'ignited' | 'burning' | 'destroyed';

export interface IgnitableEntity {
  readonly id: number;
  /** Cell-space position — a building is a cell-scale object in the spread problem. */
  x: number;
  y: number;
  /** Material key -> future agent x fuel-class effectiveness lookup. */
  material: string;
  state: EntityState;
}
