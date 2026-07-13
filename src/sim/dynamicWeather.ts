import type { WorldState } from '../core/world';
import type { IWeatherProvider } from '../models/IWeatherProvider';
import { Rng } from '../core/rng';

/** A mean-wind keyframe: at `time` seconds the map-wide wind is (u, v) m/s. */
export interface WindKeyframe {
  /** Simulated seconds at which this vector holds. */
  time: number;
  /** Wind vector pointing the way the wind blows, m/s (midflame — plan §D3). */
  u: number;
  v: number;
}

/** Spatial gust perturbation layered on the mean wind. `undefined` ⇒ mean only. */
export interface GustOptions {
  /**
   * Seed for the gust noise lattice. Uses its OWN {@link Rng}, never `world.rng` —
   * drawing from the shared stream each tick would perturb every RNG-consuming
   * model (the CA) and break determinism coupling. Default 1.
   */
  seed?: number;
  /** Per-cell speed variation, as a fraction of the mean (0.35 ⇒ ±35%). Default 0.35. */
  speedAmp?: number;
  /** Per-cell wind-direction variation, radians (0.4 ≈ ±23°). Default 0.4. */
  dirAmp?: number;
  /** Gust cells across the map — smaller = broader gusts. Default 3. */
  scale?: number;
  /** Lattice cells the gust field drifts per second (gusts move downwind-ish). Default 1/300. */
  drift?: number;
}

export interface DynamicWeatherOptions {
  /** Air temperature, °C (constant). Default 25. */
  temperatureC?: number;
  /** Relative humidity, percent (constant). Default 40. */
  relativeHumidity?: number;
  /** Precipitation rate, mm/hr (constant). Default 0. */
  rainRate?: number;
  /** Spatial gust field. Omit for a spatially-uniform (mean-only) time-varying wind. */
  gust?: GustOptions;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A periodic (wrapping) value-noise scalar field in [0, 1). Periodic so the gust
 * field can drift by an unbounded time offset and still sample cleanly (integer
 * lattice indices wrap modulo n). Seeded at construction — a pure function of
 * position thereafter, so it consumes no per-tick randomness.
 */
class PeriodicNoise {
  private readonly g: Float32Array;
  constructor(
    private readonly n: number,
    rng: Rng,
  ) {
    this.g = new Float32Array(n * n);
    for (let i = 0; i < this.g.length; i++) this.g[i] = rng.next();
  }
  private corner(cx: number, cy: number): number {
    const n = this.n;
    const x = ((cx % n) + n) % n;
    const y = ((cy % n) + n) % n;
    return this.g[y * n + x];
  }
  /** Sample at lattice coordinates (any real). */
  sample(fx: number, fy: number): number {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const a = lerp(this.corner(x0, y0), this.corner(x0 + 1, y0), tx);
    const b = lerp(this.corner(x0, y0 + 1), this.corner(x0 + 1, y0 + 1), tx);
    return lerp(a, b, ty);
  }
}

/**
 * Dynamic weather provider (Handoff §4.3, Phase 3): writes a **time-varying and
 * optionally spatially-varying** wind field each tick, plus constant ambient
 * drivers. Still just an {@link IWeatherProvider} — the fire/moisture systems read
 * layers/`env` and never touch this class (Handoff §3.1).
 *
 * **Mean wind (temporal)** is a list of {@link WindKeyframe}s, linearly interpolated
 * in time and held flat before the first / after the last. This is the headline
 * event — "a shift flips which flank is dangerous" (§4.3): author a shift as two
 * keyframes and the front reorganizes around it. Fully reproducible.
 *
 * **Gusts (spatial)** are an optional drifting coherent-noise perturbation of that
 * mean — speed varies multiplicatively, direction additively, per cell. This is
 * what makes the destination-vs-source wind-sampling convention *load-bearing*
 * (both models sample the destination cell — see `world.ts`). The gust lattice is
 * seeded once from its own {@link Rng}; it never draws from `world.rng`, so the CA's
 * seeded stream is untouched and runs stay byte-for-byte reproducible.
 *
 * Deliberately NOT modeled (kept a sandbox, not CFD — Handoff §2.1): terrain-driven
 * wind (channelling through valleys, acceleration over ridges). A future provider
 * could add it behind this same seam without touching a reader.
 */
export class DynamicWeatherProvider implements IWeatherProvider {
  readonly name = 'weather:dynamic';

  private readonly keyframes: WindKeyframe[];
  private readonly temperatureC: number;
  private readonly relativeHumidity: number;
  private readonly rainRate: number;

  private readonly gust: Required<GustOptions> | null;
  private readonly noiseSpeed: PeriodicNoise | null;
  private readonly noiseDir: PeriodicNoise | null;

  constructor(keyframes: WindKeyframe[], opts: DynamicWeatherOptions = {}) {
    if (keyframes.length === 0) throw new Error('DynamicWeatherProvider needs ≥1 wind keyframe');
    // Sort a copy by time so out-of-order authoring still interpolates correctly.
    this.keyframes = [...keyframes].sort((a, b) => a.time - b.time);
    // Duplicate times would make interpolation divide by zero → NaN wind. Reject
    // them at construction (a public authoring API) rather than emit NaN mid-run.
    for (let i = 1; i < this.keyframes.length; i++) {
      if (this.keyframes[i].time === this.keyframes[i - 1].time) {
        throw new Error(`DynamicWeatherProvider: duplicate keyframe time ${this.keyframes[i].time}`);
      }
    }
    this.temperatureC = opts.temperatureC ?? 25;
    this.relativeHumidity = opts.relativeHumidity ?? 40;
    this.rainRate = opts.rainRate ?? 0;

    if (opts.gust) {
      this.gust = {
        seed: opts.gust.seed ?? 1,
        speedAmp: opts.gust.speedAmp ?? 0.35,
        dirAmp: opts.gust.dirAmp ?? 0.4,
        scale: opts.gust.scale ?? 3,
        drift: opts.gust.drift ?? 1 / 300,
      };
      // One RNG seeds two independent lattices (speed, direction). 8×8 lattice.
      const rng = new Rng(this.gust.seed);
      this.noiseSpeed = new PeriodicNoise(8, rng);
      this.noiseDir = new PeriodicNoise(8, rng);
    } else {
      this.gust = null;
      this.noiseSpeed = null;
      this.noiseDir = null;
    }
  }

  /** Interpolate the mean wind vector at time `t` from the keyframes. */
  private meanWind(t: number): { u: number; v: number } {
    const kf = this.keyframes;
    if (t <= kf[0].time) return { u: kf[0].u, v: kf[0].v };
    const last = kf[kf.length - 1];
    if (t >= last.time) return { u: last.u, v: last.v };
    for (let i = 1; i < kf.length; i++) {
      if (t <= kf[i].time) {
        const a = kf[i - 1];
        const b = kf[i];
        const f = (t - a.time) / (b.time - a.time);
        return { u: lerp(a.u, b.u, f), v: lerp(a.v, b.v, f) };
      }
    }
    return { u: last.u, v: last.v }; // unreachable; keeps the compiler happy
  }

  step(world: WorldState, _dt: number): void {
    const { width, height, layers } = world;
    const t = world.clock.time;
    const { u: mu, v: mv } = this.meanWind(t);

    world.env.temperatureC = this.temperatureC;
    world.env.relativeHumidity = this.relativeHumidity;
    world.env.rainRate = this.rainRate;

    const windU = layers.windU.data;
    const windV = layers.windV.data;

    // Uniform-in-space fast path: no gusts ⇒ one vector everywhere.
    if (!this.gust) {
      windU.fill(mu);
      windV.fill(mv);
      return;
    }

    // Gusts perturb the mean per cell. Decompose the mean once, then modulate
    // speed multiplicatively and direction additively from the drifting lattice.
    const meanSpeed = Math.hypot(mu, mv);
    const meanDir = Math.atan2(mv, mu); // 0 if calm — gusts then modulate nothing
    const { speedAmp, dirAmp, scale, drift } = this.gust;
    const nS = this.noiseSpeed!;
    const nD = this.noiseDir!;
    const shift = drift * t; // lattice-space drift → gusts travel over time

    for (let y = 0; y < height; y++) {
      const ly = (y / height) * scale + shift;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const lx = (x / width) * scale + shift;
        const s = (nS.sample(lx, ly) - 0.5) * 2; // [-1, 1)
        const d = (nD.sample(lx, ly) - 0.5) * 2; // [-1, 1)
        const speed = meanSpeed * (1 + speedAmp * s);
        const dir = meanDir + dirAmp * d;
        windU[i] = speed * Math.cos(dir);
        windV[i] = speed * Math.sin(dir);
      }
    }
  }
}
