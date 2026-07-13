import { FireState, type WorldState } from '../core/world';
import type { System } from '../core/system';
import { fractionToByte } from '../core/moisture';

/**
 * Phase-4 slice 4c (`docs/plans/phase-4-firefighting.md` §4c) — the persistence
 * substrate for aerial fire retardant. A plain {@link System} (like
 * {@link FuelMoistureSystem} / {@link SpottingSystem}, NOT a sixth model seam) that
 * owns the `retardant` layer written by an {@link Aircraft} drop: each tick it
 * **decays** every treated cell's potency on retardant's own slow schedule and,
 * while a cell is still treated, **re-pins** `moisture` high on that *unburned* cell.
 *
 * **Why a dedicated layer + this system, not just a `moisture` spike (the 4c
 * decision, plan §4c).** Water and retardant both suppress by keeping unburned fuel
 * too wet to carry — but retardant must persist *longer* than water. Water rides the
 * single slow drydown law of {@link FuelMoistureSystem}; one moisture layer with one
 * decay law cannot also give some cells a *slower* decay. So retardant gets its own
 * layer carrying its own (much longer) decay, and this system re-pins `moisture` from
 * it. **The fire model is never told about retardant** — it still reads only
 * `moisture` — so the mounted model's spread math stays untouched (the Phase-4
 * layer-only spine). A deliberate divergence from the plan's B-sketch (fire model
 * reads a retardant layer): the sandbox keeps the spine intact and, as a free bonus,
 * spotting's moisture-gated landing check makes retardant lines resist ember ignition
 * too. Retardant here is honestly "water that lasts": identical ROS effect while
 * active, distinguished by duration.
 *
 * **Persistent owner, decoupled from the aircraft (advisor note).** The re-pin must
 * fire every tick for the retardant's *whole* duration — long after the aircraft has
 * flown home and been re-tasked. So the field's lifetime lives here, on a map-walking
 * system, NOT in the aircraft's private state.
 *
 * **Pipeline order is load-bearing:** `weather → moisture → suppression → fire →
 * spotting`, and this system sits in the suppression band **after the aircraft**
 * (so a same-tick drop is honoured) and **after {@link FuelMoistureSystem}** (so the
 * re-pin overrides this tick's drydown), but **before the fire model** (so the fire
 * reads the pinned bed this tick).
 *
 * **Falloff carries through.** The aircraft already scaled the deposited *potency* by
 * the crown-fire falloff, and the pinned moisture is proportional to potency
 * ({@link PIN_MAX_MOISTURE}), so a near-useless drop on a flaming crown pins a
 * moisture too low to matter — the falloff is preserved, not re-litigated here.
 *
 * **Determinism (Handoff §3.2).** Pure arithmetic over typed arrays, fixed row-major
 * sweep, each cell independent — **no `world.rng` draw** (load-bearing: this runs
 * before {@link SpottingSystem}, the only rng consumer). A private Float32 mirror
 * carries sub-byte decay so a slow per-tick decrement doesn't stall on byte rounding,
 * exactly as {@link FuelMoistureSystem} does for moisture; it **adopts** any external
 * write to the byte layer (a fresh drop) when the stored byte no longer matches what
 * it last wrote.
 */
export class RetardantSystem implements System {
  readonly name = 'suppression:retardant-field';

  /** Seconds for a full-potency (255) drop to decay to zero. Realistic: retardant
   *  lasts hours (until rain/burial), far longer than water's ~an-hour drydown, so it
   *  visibly OUTLASTS a water drop (plan §4c exit). Default 4 h. */
  private static readonly DEFAULT_DURATION_SEC = 14400;
  /** Moisture fraction a *full*-potency cell is pinned to — the aircraft's full-strength
   *  water knockdown, so retardant ≈ water while active. Above every Anderson extinction
   *  moisture, so ROS → 0 where full retardant sits. Scales linearly with potency, so the
   *  crown-fire falloff (which cut the deposited potency) carries straight through. */
  private static readonly PIN_MAX_MOISTURE = 0.9;

  private readonly decayPerSec: number;
  private readonly pinMaxMoisture: number;
  /** High-precision mirror of the retardant byte layer; carries sub-byte decay. */
  private retF: Float32Array | null = null;

  constructor(opts: { durationSeconds?: number; pinMaxMoisture?: number } = {}) {
    const duration = opts.durationSeconds ?? RetardantSystem.DEFAULT_DURATION_SEC;
    this.decayPerSec = duration > 0 ? 255 / duration : Infinity;
    this.pinMaxMoisture = opts.pinMaxMoisture ?? RetardantSystem.PIN_MAX_MOISTURE;
  }

  step(world: WorldState, dt: number): void {
    const { layers } = world;
    const ret = layers.retardant.data;
    const moist = layers.moisture.data;
    const fire = layers.fire.data;

    if (this.retF === null || this.retF.length !== ret.length) {
      this.retF = new Float32Array(ret.length);
      for (let i = 0; i < ret.length; i++) this.retF[i] = ret[i];
    }
    const rF = this.retF;
    const decay = this.decayPerSec * dt;

    for (let i = 0; i < ret.length; i++) {
      // Adopt an external write (a fresh aircraft drop raised the byte): the layer is
      // authoritative, reseed the mirror — exactly as FuelMoistureSystem adopts paint.
      if (Math.round(rF[i]) !== ret[i]) rF[i] = ret[i];
      if (rF[i] <= 0) continue; // untreated cell — the overwhelmingly common case

      // Decay on retardant's own slow schedule (independent of the moisture drydown).
      let p = rF[i] - decay;
      if (p < 0) p = 0;
      rF[i] = p;
      const potByte = Math.round(p);
      ret[i] = potByte;
      if (potByte <= 0) continue;

      // Re-pin moisture on UNBURNED fuel only (the front spreads into unburned cells;
      // a burning/burned cell's moisture is moot). Pin strength ∝ potency, so a
      // falloff-weakened drop pins a weak (possibly sub-extinction) moisture. Never
      // dry a wetter cell — raise only (max), like every other knockdown.
      if (fire[i] !== FireState.Unburned) continue;
      const pinByte = fractionToByte((potByte / 255) * this.pinMaxMoisture);
      if (moist[i] < pinByte) moist[i] = pinByte;
    }
  }
}
