import { FireState, type WorldState } from '../core/world';
import type { ISuppressionAgent } from '../models/ISuppressionAgent';
import { fractionToByte } from '../core/moisture';
import { advanceToward, type TravelParams } from './suppressionTravel';

/**
 * Phase-4 slice 4c (`docs/plans/phase-4-firefighting.md` §4c) — an air tanker: the
 * third and last exercise of the {@link ISuppressionAgent} seam. It shares the
 * ground units' deterministic travel substrate ({@link advanceToward}) but flies —
 * fuel/slope resistance is 1 everywhere — with **long travel legs and a big reload
 * cycle** (return to base to refill). It makes discrete **passes**: fly out, lay
 * one drop over a wide footprint, return to base, reload, and only then fly the
 * next order. One drop per sortie, exactly as a real tanker.
 *
 * Two loads:
 *  - **water** — a large `moisture` knockdown (same mechanism as the engine, bigger
 *    footprint). Temporary: it rides the shared slow drydown of {@link FuelMoistureSystem}.
 *  - **retardant** — writes the dedicated `retardant` layer, which {@link RetardantSystem}
 *    decays on its own slow schedule and re-pins into `moisture` for a long duration.
 *    Retardant is a *pre-treatment* of unburned fuel ahead of the front; it **persists
 *    past** a water drop's drydown (plan §4c exit). See {@link RetardantSystem}.
 *
 * **The crown-fire lesson (§4.4 — the phase's signature teaching moment).** Aerial
 * suppressant dropped on — or right at the edge of — an **active crown run** is
 * near-useless. Effectiveness falls off with **canopy × local flaming activity**
 * ({@link crownFalloffEffectiveness}), NOT canopy alone: a drop on unburned timber
 * *well ahead* of the front still pre-treats it (that indirect pre-treatment is the
 * doctrine the phase teaches), but a drop on a flaming timber crown lands almost no
 * effective suppressant, so the front runs straight through it. Pinned by
 * `tests/aircraft.test.ts`.
 *
 * **Layer-only, exactly like the crew, engine and spotting (plan §"layer-only").**
 * The aircraft reads/writes ONLY data layers — a `moisture` spike (water) or a
 * `retardant` write, both on *unburned* fuel — and NEVER touches a fire model's
 * private spread state or calls another system (Handoff §3.1). It un-burns nothing.
 *
 * **Pipeline order is load-bearing:** `weather → moisture → suppression → fire →
 * spotting`. A water knockdown must land in `moisture` *after* the drydown step and
 * *before* the fire model reads it this tick; a retardant write must land before
 * {@link RetardantSystem} (also in the suppression band, after the aircraft) re-pins
 * it into `moisture` for the fire model to read this tick.
 *
 * **Determinism (Handoff §3.2).** Travel, the drop, and the reload cycle are pure
 * arithmetic — **no `world.rng` draw at all**. Beyond reproducibility this matters
 * because the aircraft steps *before* {@link SpottingSystem}, the only `world.rng`
 * consumer in the Rothermel pipeline; a draw here would shift spotting's stream and
 * desync it. The *player command* layer (clicks → orders) is browser-only and
 * non-deterministic, living outside the determinism test like the terrain editor.
 */

/** The two aerial loads. Water is temporary; retardant is a persistent pre-treatment. */
export type AerialLoad = 'water' | 'retardant';

/** A single player order: make one pass dropping `load` centred on (`x`, `y`). */
export interface AircraftOrder {
  readonly load: AerialLoad;
  readonly x: number;
  readonly y: number;
}

export interface AircraftOptions {
  /** Base cell x (spawn + reload point). */
  x: number;
  /** Base cell y (spawn + reload point). */
  y: number;
  /** Cruise speed [cells/sec]. Flying ignores fuel/slope, so this holds everywhere. */
  speed?: number;
  /** Seconds to reload at base between sorties (a long §4.4 turnaround). */
  reloadSeconds?: number;
  /** Drop footprint radius [cells] — a wide swath, bigger than the engine's. */
  dropRadius?: number;
  /** Agent-type key (`air-tanker` default; `helicopter` for a smaller/faster variant). */
  agentType?: string;
  /** Label suffix so several aircraft get distinct system names. */
  id?: string;
}

// --- sandbox tuning levers (documented; all deterministic) -------------------

/** Default cruise speed [cells/sec] — fast: a tanker covers ground far quicker than
 *  a ground unit, so its cost is the long RELOAD leg, not the transit. */
const DEFAULT_SPEED = 0.6;
/** Default reload time [s] — return-to-base + tank fill is minutes; the turnaround
 *  is the aircraft's whole logistics lever (few, expensive passes). */
const DEFAULT_RELOAD_SECONDS = 180;
/** Default drop footprint radius [cells] — a 7×7 swath, wider than the engine's 5×5. */
const DEFAULT_DROP_RADIUS = 3;
/** Water knockdown target [moisture fraction] at full effectiveness — the engine's
 *  saturation level; above every Anderson extinction moisture, so ROS → 0 where it
 *  lands at full strength. Scaled DOWN by the crown-fire falloff (see below). */
const KNOCKDOWN_MOISTURE = 0.9;
/** Retardant potency laid at full effectiveness [0..255 byte]. {@link RetardantSystem}
 *  maps potency → pinned moisture, so full potency ≈ the water knockdown but held far
 *  longer. Scaled down by the falloff exactly like water. */
const RETARDANT_MAX_POTENCY = 255;
/**
 * Crown-fire falloff steepness. Effectiveness = 1 − k·localCrown, where localCrown is
 * the canopy fraction of the most intense flaming cell in the drop cell's 3×3. k = 1.1
 * makes a flaming timber crown (canopy ≈ 200/255 = 0.78) drop to ≈0.14 effectiveness →
 * a water deposit of 0.9·0.14 ≈ 0.13, *below* timber's 0.25 extinction moisture, so it
 * does not stop the front (near-useless). Burning grass (canopy ≈ 0.04) barely dents
 * effectiveness (≈0.96) — a surface grass fire IS suppressible from the air, the honest
 * distinction. Unburned fuel ahead (no flaming neighbour) → localCrown 0 → full strength.
 */
const CROWN_FALLOFF = 1.1;

/**
 * Crown-fire effectiveness of an aerial drop given the local crown-run intensity
 * `localCrownFrac` (the canopy fraction, 0..1, of the most intense *actively flaming*
 * cell at or beside the drop cell). Pure so the falloff can be pinned directly.
 * Returns a 0..1 multiplier on the deposited suppressant. See {@link CROWN_FALLOFF}.
 */
export function crownFalloffEffectiveness(localCrownFrac: number): number {
  const eff = 1 - CROWN_FALLOFF * localCrownFrac;
  return eff < 0 ? 0 : eff > 1 ? 1 : eff;
}

export class Aircraft implements ISuppressionAgent {
  readonly agentType: string;
  readonly name: string;

  private px: number;
  private py: number;
  private readonly baseX: number;
  private readonly baseY: number;
  private readonly travel_: TravelParams;
  private readonly reloadSeconds: number;
  private readonly dropRadius: number;

  /** FIFO of pending sorties; the head is the active one (0 or more queued). */
  private readonly orders: AircraftOrder[] = [];
  /** True while flying back to base + topping up between sorties. */
  private returning = false;
  /** Seconds of reload banked once back on the base cell. */
  private reloadProgress = 0;
  /** Whether the aircraft is currently carrying a load (false between drop and reload). */
  private loaded = true;

  constructor(opts: AircraftOptions) {
    this.px = opts.x;
    this.py = opts.y;
    this.baseX = opts.x;
    this.baseY = opts.y;
    // Flying: resistance 1 for every fuel id (empty table → the `?? 1` default) and
    // no upslope penalty, so travel is terrain-independent.
    this.travel_ = { speed: opts.speed ?? DEFAULT_SPEED, resistance: {}, slopePenalty: 0 };
    this.reloadSeconds = opts.reloadSeconds ?? DEFAULT_RELOAD_SECONDS;
    this.dropRadius = opts.dropRadius ?? DEFAULT_DROP_RADIUS;
    this.agentType = opts.agentType ?? 'air-tanker';
    this.name = `suppression:${this.agentType}${opts.id ? `:${opts.id}` : ''}`;
  }

  // --- command surface (called by the browser command shell / tests) ---------

  /** Queue a water drop (FIFO). Temporary knockdown; rides the shared moisture drydown. */
  orderWaterDrop(x: number, y: number): void {
    this.orders.push({ load: 'water', x, y });
  }

  /** Queue a retardant drop (FIFO). Persistent pre-treatment via the retardant layer. */
  orderRetardantDrop(x: number, y: number): void {
    this.orders.push({ load: 'retardant', x, y });
  }

  /** Cancel pending sorties. An in-progress return-to-base still completes (the
   *  aircraft is committed to landing before it can take a new order). */
  standDown(): void {
    this.orders.length = 0;
  }

  get cellX(): number {
    return Math.round(this.px);
  }
  get cellY(): number {
    return Math.round(this.py);
  }
  get isIdle(): boolean {
    return this.orders.length === 0 && !this.returning;
  }
  /** True while flying back to base / reloading between sorties. */
  get isReturning(): boolean {
    return this.returning;
  }
  /** True while carrying a load (false between the drop and the next reload). */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** The cell the aircraft is flying toward: its base while returning, else the drop
   *  target. Null when idle at base. */
  get targetCell(): { x: number; y: number } | null {
    if (this.returning) return { x: this.baseX, y: this.baseY };
    if (this.orders.length === 0) return null;
    const o = this.orders[0];
    return { x: o.x, y: o.y };
  }

  // --- per-tick execution ----------------------------------------------------

  step(world: WorldState, dt: number): void {
    if (this.returning) {
      this.runReturn(dt, world);
      return;
    }

    if (this.orders.length === 0) return; // idle at base
    const order = this.orders[0];

    // Travel gates the drop, exactly as the ground units: a tick that moves the
    // aircraft is spent flying; the drop happens on a tick that begins on target.
    const r = advanceToward(world, this.px, this.py, order.x, order.y, this.travel_, dt);
    this.px = r.x;
    this.py = r.y;
    if (!r.arrived) return;

    this.executeDrop(world, order);
    this.orders.shift(); // one drop per sortie
    this.loaded = false;
    this.returning = true; // fly home to reload before the next pass
  }

  /** Fly back to base and reload over {@link reloadSeconds}, then release the aircraft. */
  private runReturn(dt: number, world: WorldState): void {
    const r = advanceToward(world, this.px, this.py, this.baseX, this.baseY, this.travel_, dt);
    this.px = r.x;
    this.py = r.y;
    if (!r.arrived) return; // still flying home

    this.reloadProgress += dt;
    if (this.reloadProgress >= this.reloadSeconds) {
      this.loaded = true;
      this.returning = false;
      this.reloadProgress = 0;
      // Next tick falls through: if another sortie is queued it flies; else idle.
    }
  }

  /**
   * Lay one drop over the footprint on **unburned** fuel, scaled per cell by the
   * crown-fire falloff. Water raises `moisture` (temporary); retardant writes the
   * `retardant` layer ({@link RetardantSystem} holds it). Burning/Burned cells are
   * skipped — moisture is read at the *destination* cell the front spreads into, and
   * pre-treating unburned fuel ahead of the front is the whole point.
   */
  private executeDrop(world: WorldState, order: AircraftOrder): void {
    const { width, height, layers } = world;
    const fire = layers.fire.data;
    for (let dy = -this.dropRadius; dy <= this.dropRadius; dy++) {
      for (let dx = -this.dropRadius; dx <= this.dropRadius; dx++) {
        const x = order.x + dx;
        const y = order.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = y * width + x;
        if (fire[i] !== FireState.Unburned) continue; // deposit on unburned fuel only

        const eff = crownFalloffEffectiveness(localCrownIntensity(world, x, y));

        if (order.load === 'water') {
          const wetByte = fractionToByte(KNOCKDOWN_MOISTURE * eff);
          if (layers.moisture.data[i] < wetByte) layers.moisture.data[i] = wetByte;
        } else {
          const potByte = Math.round(RETARDANT_MAX_POTENCY * eff);
          if (layers.retardant.data[i] < potByte) layers.retardant.data[i] = potByte;
        }
      }
    }
  }
}

/**
 * Local crown-run intensity for the drop cell (`x`, `y`): the canopy fraction (0..1)
 * of the most intense **actively flaming** cell in the 3×3 around it. Flaming only —
 * a `Burned` cell is spent (no crown run to fight), so unlike the fire model's
 * `isIgnited` (which counts Burned as a spread source) this counts `Burning` alone.
 * Unburned fuel with no flaming neighbour returns 0 → the drop lands at full strength.
 */
function localCrownIntensity(world: WorldState, x: number, y: number): number {
  const { width, height, layers } = world;
  const fire = layers.fire.data;
  const canopy = layers.canopy.data;
  let localCrown = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (fire[ni] !== FireState.Burning) continue;
      const c = canopy[ni] / 255;
      if (c > localCrown) localCrown = c;
    }
  }
  return localCrown;
}
