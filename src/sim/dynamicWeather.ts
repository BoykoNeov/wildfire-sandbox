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
  /**
   * Seconds the gust field is held between rewrites. The field drifts at `drift`
   * lattice cells per second and the mean wind ramps over keyframes hundreds of
   * seconds apart, so rewriting 2×N floats every 1-second tick was pure cost
   * (profiled as the third most expensive system). Held for `refreshSeconds`, the
   * field is still a pure function of `clock.time` (deterministic) and moves
   * indistinguishably. `0` rewrites every tick. Default 4.
   */
  refreshSeconds?: number;
}

/**
 * An ambient-driver keyframe: at `time` seconds the map-wide temperature,
 * humidity and rain hold these values. Linearly interpolated like wind, so a
 * scenario can author a weather front (RH climbing, temperature falling, a rain
 * pulse arriving and clearing) as a handful of rows.
 */
export interface AmbientKeyframe {
  /** Simulated seconds at which these drivers hold. */
  time: number;
  /** Air temperature, °C. */
  temperatureC: number;
  /** Relative humidity, percent 0..100. */
  relativeHumidity: number;
  /** Precipitation rate, mm/hr. */
  rainRate: number;
}

export interface DynamicWeatherOptions {
  /** Air temperature, °C (constant). Default 25. Ignored when `ambient` is given. */
  temperatureC?: number;
  /** Relative humidity, percent (constant). Default 40. Ignored when `ambient` is given. */
  relativeHumidity?: number;
  /** Precipitation rate, mm/hr (constant). Default 0. Ignored when `ambient` is given. */
  rainRate?: number;
  /**
   * Time-varying ambient drivers (≥1 keyframe), interpolated exactly as the wind
   * keyframes are. Overrides the three constants above.
   */
  ambient?: AmbientKeyframe[];
  /** Spatial gust field. Omit for a spatially-uniform (mean-only) time-varying wind. */
  gust?: GustOptions;
}

/** Cells per gust sample along each axis (see the gust loop in `step`). */
const GUST_BLOCK = 4;

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
 * **Ambient drivers** (temperature, humidity, rain) are either constants or a
 * second list of keyframes ({@link AmbientKeyframe}) interpolated the same way —
 * a weather front is authored as a few rows and the moisture system does the rest.
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
  private readonly ambient: AmbientKeyframe[];

  private readonly gust: Required<GustOptions> | null;
  private readonly noiseSpeed: PeriodicNoise | null;
  private readonly noiseDir: PeriodicNoise | null;
  /** Sim time of the last gust-field write; `-Infinity` forces the first. */
  private lastGustWrite = -Infinity;

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
    // Constant drivers are just a single ambient keyframe (held flat forever).
    const ambient = opts.ambient?.length
      ? [...opts.ambient].sort((a, b) => a.time - b.time)
      : [
          {
            time: 0,
            temperatureC: opts.temperatureC ?? 25,
            relativeHumidity: opts.relativeHumidity ?? 40,
            rainRate: opts.rainRate ?? 0,
          },
        ];
    for (let i = 1; i < ambient.length; i++) {
      if (ambient[i].time === ambient[i - 1].time) {
        throw new Error(`DynamicWeatherProvider: duplicate ambient keyframe time ${ambient[i].time}`);
      }
    }
    this.ambient = ambient;

    if (opts.gust) {
      this.gust = {
        seed: opts.gust.seed ?? 1,
        speedAmp: opts.gust.speedAmp ?? 0.35,
        dirAmp: opts.gust.dirAmp ?? 0.4,
        scale: opts.gust.scale ?? 3,
        drift: opts.gust.drift ?? 1 / 300,
        refreshSeconds: opts.gust.refreshSeconds ?? 4,
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

  /** Interpolate the ambient drivers at time `t` straight into `world.env`. */
  private writeAmbient(world: WorldState, t: number): void {
    const kf = this.ambient;
    const env = world.env;
    let a = kf[0];
    let b = kf[0];
    let f = 0;
    if (t >= kf[kf.length - 1].time) {
      a = b = kf[kf.length - 1];
    } else if (t > kf[0].time) {
      for (let i = 1; i < kf.length; i++) {
        if (t <= kf[i].time) {
          a = kf[i - 1];
          b = kf[i];
          f = (t - a.time) / (b.time - a.time);
          break;
        }
      }
    }
    env.temperatureC = lerp(a.temperatureC, b.temperatureC, f);
    env.relativeHumidity = lerp(a.relativeHumidity, b.relativeHumidity, f);
    env.rainRate = lerp(a.rainRate, b.rainRate, f);
  }

  step(world: WorldState, _dt: number): void {
    const { width, height, layers } = world;
    const t = world.clock.time;
    const { u: mu, v: mv } = this.meanWind(t);

    this.writeAmbient(world, t);

    const windU = layers.windU.data;
    const windV = layers.windV.data;

    // Uniform-in-space fast path: no gusts ⇒ one vector everywhere.
    if (!this.gust) {
      windU.fill(mu);
      windV.fill(mv);
      return;
    }

    // Hold the field between refreshes (see `GustOptions.refreshSeconds`). The
    // first tick always writes, so a reader never sees the all-zero initial layer.
    if (t - this.lastGustWrite < this.gust.refreshSeconds) return;
    this.lastGustWrite = t;

    // Gusts perturb the mean per cell. Decompose the mean once, then modulate
    // speed multiplicatively and direction additively from the drifting lattice.
    // The lattice spans only ~`scale` cells across the whole map, so sampling it
    // once per GUST_BLOCK×GUST_BLOCK block (and filling the block) is visually
    // identical and ~16× cheaper than two noise samples + a sin/cos per cell —
    // this was the most expensive system in the pipeline. Still deterministic.
    const meanSpeed = Math.hypot(mu, mv);
    const meanDir = Math.atan2(mv, mu); // 0 if calm — gusts then modulate nothing
    const { speedAmp, dirAmp, scale, drift } = this.gust;
    const nS = this.noiseSpeed!;
    const nD = this.noiseDir!;
    const shift = drift * t; // lattice-space drift → gusts travel over time
    const B = GUST_BLOCK;

    for (let by = 0; by < height; by += B) {
      const ly = (by / height) * scale + shift;
      const yEnd = Math.min(height, by + B);
      for (let bx = 0; bx < width; bx += B) {
        const lx = (bx / width) * scale + shift;
        const s = (nS.sample(lx, ly) - 0.5) * 2; // [-1, 1)
        const d = (nD.sample(lx, ly) - 0.5) * 2; // [-1, 1)
        const speed = meanSpeed * (1 + speedAmp * s);
        const dir = meanDir + dirAmp * d;
        const u = speed * Math.cos(dir);
        const v = speed * Math.sin(dir);
        const xEnd = Math.min(width, bx + B);
        for (let y = by; y < yEnd; y++) {
          const row = y * width;
          for (let x = bx; x < xEnd; x++) {
            windU[row + x] = u;
            windV[row + x] = v;
          }
        }
      }
    }
  }
}
