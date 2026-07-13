import type { WorldState } from '../core/world';
import type { System } from '../core/system';
import { byteToFraction, fractionToByte } from '../core/moisture';
import { equilibriumMoistureFraction } from './emc';

/**
 * Phase-3 fuel-moisture dynamics (roadmap §6 "dynamic wind/rain/spotting";
 * `docs/plans/phase-3-moisture-dynamics.md`). A plain {@link System} that *writes*
 * `layers.moisture` each tick so the dead-fuel field **evolves** instead of staying
 * the static painted layer Phase 2 gave it. The fire model still only *reads*
 * moisture — systems talk through layers, never call each other (Handoff §3.1).
 *
 * **Not a sixth seam.** The five model seams are fixed by the Handoff; this is an
 * ordinary system, wired weather → moisture → fire. It reads the ambient drivers
 * `world.env` (written by `IWeatherProvider`) and the `layers.moisture` byte layer;
 * it writes `layers.moisture`.
 *
 * **Model — 1-hr dead-fuel timelag toward EMC (Simard/NFDRS lineage).** Fine dead
 * fuel relaxes exponentially toward a target moisture with a size-class time
 * constant τ:
 *
 *   M ← M + (M* − M)·(1 − exp(−dt/τ))
 *
 * - **Drying / normal:** target `M*` = the Simard (1968) equilibrium moisture
 *   content for the ambient temperature + humidity (`emc.ts`), τ = **1 hr** — the
 *   1-hr (fine) dead-fuel timelag. This layer is the fine class (§D6 keeps a single
 *   dead moisture; per-class 1-/10-/100-hr split stays a deferred model-side tweak).
 * - **Wetting / rain:** when `env.rainRate > 0`, target = a saturation fraction and
 *   τ is shorter (rain wets faster than fuels dry). This is the *least* standardized
 *   piece — EMC is well-defined science; precipitation response is not — so it is a
 *   deliberate **sandbox simplification**, not canon. Intensity-scaling of the
 *   wetting rate by `rainRate`, and solar/wind acceleration of the drying τ, are
 *   documented deferrals (Phase-3 refinements), not part of this first step.
 *
 * The teachable consequence: a rain pulse can push moisture across a fuel's Rothermel
 * moisture-of-extinction, dropping ROS to zero and halting the front. (One honest
 * limitation carried from Phase 2: the Rothermel `progress` accumulator only
 * increases, so a cell already primed near ignition stays primed after rain zeroes
 * ROS — same class as the no-extinguish note; retreat/suppression is Phase 4.)
 *
 * **Determinism.** Pure arithmetic over typed arrays (`Math.exp`, no `Math.random`)
 * with a fixed row-major sweep. Each cell depends only on its own prior value plus
 * the uniform drivers — no neighbour reads — so the update is **in place** (no
 * double-buffer; that would be dead ceremony here, unlike neighbour-coupled spread).
 *
 * **Sub-byte precision + editor coexistence.** The layer is a Uint8 (~0.4% per
 * step); at dt = 1 s one tick moves moisture far less than one byte, so integrating
 * in byte space would stall on rounding. The system therefore keeps a private
 * Float32 mirror carrying sub-byte change and writes the quantized byte each tick.
 * Because the terrain editor can paint the byte layer mid-run, before integrating it
 * **adopts** any cell whose stored byte no longer matches what it last wrote — the
 * painted value wins, exactly as the pre-tick buffer is authoritative for spread.
 */
export class FuelMoistureSystem implements System {
  readonly name = 'moisture:timelag-emc';

  /** Fine (1-hr) dead-fuel timelag, seconds. */
  private static readonly DEAD_1HR_TIMELAG_SEC = 3600;
  /** Wetting timelag under rain, seconds — fuels wet faster than they dry (sandbox). */
  private static readonly WETTING_TIMELAG_SEC = 1800;
  /** Saturation target for fully-rained fine dead fuel, fraction (sandbox constant). */
  private static readonly RAIN_SATURATION_FRACTION = 0.6;

  /** High-precision mirror of the byte layer; carries sub-byte per-tick change. */
  private moistureF: Float32Array | null = null;

  step(world: WorldState, dt: number): void {
    const moist = world.layers.moisture.data;
    const env = world.env;

    if (this.moistureF === null || this.moistureF.length !== moist.length) {
      this.moistureF = new Float32Array(moist.length);
      for (let i = 0; i < moist.length; i++) this.moistureF[i] = byteToFraction(moist[i]);
    }
    const mF = this.moistureF;

    const raining = env.rainRate > 0;
    const target = raining
      ? FuelMoistureSystem.RAIN_SATURATION_FRACTION
      : equilibriumMoistureFraction(env.relativeHumidity, env.temperatureC);
    const tau = raining
      ? FuelMoistureSystem.WETTING_TIMELAG_SEC
      : FuelMoistureSystem.DEAD_1HR_TIMELAG_SEC;
    // Forward-Euler-exact relaxation coefficient; dt-robust if the schedule changes.
    const alpha = 1 - Math.exp(-dt / tau);

    for (let i = 0; i < moist.length; i++) {
      // Adopt external edits (editor paint): if the stored byte no longer matches
      // what we last wrote, the layer is authoritative — reseed the mirror from it.
      if (fractionToByte(mF[i]) !== moist[i]) mF[i] = byteToFraction(moist[i]);

      let m = mF[i] + (target - mF[i]) * alpha;
      if (m < 0) m = 0;
      else if (m > 1) m = 1;
      mF[i] = m;
      moist[i] = fractionToByte(m);
    }
  }
}
