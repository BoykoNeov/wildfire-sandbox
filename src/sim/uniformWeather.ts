import type { WorldState } from '../core/world';
import type { IWeatherProvider } from '../models/IWeatherProvider';

/**
 * Uniform wind provider (Handoff §4.3): writes one constant wind vector into
 * every cell of the wind field each tick. Phase 1 / scripted — later providers
 * can write spatially-varying or imported wind and the fire model is unaffected.
 */
export class UniformWeatherProvider implements IWeatherProvider {
  readonly name = 'weather:uniform';

  constructor(
    /** Wind vector in cells/second, pointing the way the wind blows. */
    public u: number,
    public v: number,
  ) {}

  step(world: WorldState, _dt: number): void {
    world.layers.windU.data.fill(this.u);
    world.layers.windV.data.fill(this.v);
  }
}
