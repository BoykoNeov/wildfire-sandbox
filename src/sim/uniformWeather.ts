import type { WorldState } from '../core/world';
import type { IWeatherProvider } from '../models/IWeatherProvider';

/** Ambient-driver overrides for {@link UniformWeatherProvider}. */
export interface UniformWeatherOptions {
  /** Air temperature, °C. Default 25. */
  temperatureC?: number;
  /** Relative humidity, percent 0..100. Default 40. */
  relativeHumidity?: number;
  /** Precipitation rate, mm/hr. Default 0. */
  rainRate?: number;
}

/**
 * Uniform weather provider (Handoff §4.3): writes one constant wind vector into
 * every cell of the wind field, plus constant ambient drivers (temperature,
 * humidity, rain) into `world.env`, each tick. Phase 1 / scripted — later providers
 * can write spatially-varying or imported weather and the fire/moisture systems are
 * unaffected (they read layers / env, never this class).
 */
export class UniformWeatherProvider implements IWeatherProvider {
  readonly name = 'weather:uniform';

  private readonly temperatureC: number;
  private readonly relativeHumidity: number;
  private readonly rainRate: number;

  constructor(
    /**
     * Wind vector pointing the way the wind blows. The Rothermel fire model reads
     * the components as midflame wind in m/s (plan §D3); the legacy CA reads them
     * as a dimensionless down-wind alignment strength. See `world.ts` `windU/windV`.
     */
    public u: number,
    public v: number,
    opts: UniformWeatherOptions = {},
  ) {
    this.temperatureC = opts.temperatureC ?? 25;
    this.relativeHumidity = opts.relativeHumidity ?? 40;
    this.rainRate = opts.rainRate ?? 0;
  }

  step(world: WorldState, _dt: number): void {
    world.layers.windU.data.fill(this.u);
    world.layers.windV.data.fill(this.v);
    world.env.temperatureC = this.temperatureC;
    world.env.relativeHumidity = this.relativeHumidity;
    world.env.rainRate = this.rainRate;
  }
}
