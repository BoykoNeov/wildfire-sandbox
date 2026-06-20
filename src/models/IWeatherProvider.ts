import type { System } from '../core/system';

/**
 * Weather seam (Handoff §3.3): supplies the wind field, moisture drivers and
 * events by writing into world layers. Phase 1: uniform/scripted. Later:
 * spatially-varying or data-driven — and the fire model never changes.
 */
export interface IWeatherProvider extends System {}
