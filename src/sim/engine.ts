import { FireState, type WorldState } from '../core/world';
import type { ISuppressionAgent } from '../models/ISuppressionAgent';
import { fractionToByte } from '../core/moisture';
import { advanceToward, type TravelParams } from './suppressionTravel';
import { Fuel } from './basicFuelModel';

/**
 * Phase-4 slice 4b (`docs/plans/phase-4-firefighting.md` §4b) — an engine: the
 * second exercise of the {@link ISuppressionAgent} seam. It shares the crew's
 * deterministic travel/work substrate ({@link advanceToward}) but its
 * distinguishing lever is a **finite water tank**. Direct attack lays a wider,
 * wetter knockdown than a hand crew, but every second of application **draws the
 * tank down**; when it runs dry the engine breaks off, drives to a **static refill
 * point**, tops up over time, and **resumes** the same held station — a §4.4
 * logistics reload cycle.
 *
 * **Layer-only, exactly like the crew and spotting (plan §"layer-only").** The
 * engine reads/writes ONLY data layers — here just a `moisture` knockdown spike on
 * *unburned* fuel — and NEVER touches a fire model's private spread state or calls
 * another system (Handoff §3.1). It un-burns nothing: Rothermel reads moisture at
 * the *destination* cell the front spreads into, so wetting unburned fuel ahead of
 * the edge drops its ROS toward zero. The tank does not extinguish flames; it
 * denies the front fuel, temporarily — the durable stop is still the crew's cut
 * line (the 4b teaching beat: even with water an engine only *holds* an edge).
 *
 * **Pipeline order is load-bearing:** `weather → moisture → suppression → fire →
 * spotting`. A knockdown must land in `moisture` *after* the drydown step and
 * *before* the fire model reads it this tick (so the drop protects the bed the fire
 * evaluates now). Suppression before moisture would let the same-tick drydown eat
 * the drop.
 *
 * **Determinism (Handoff §3.2).** Travel, water draw-down and the reload cycle are
 * pure arithmetic — **no `world.rng` draw at all**. Beyond reproducibility this
 * matters because the engine steps *before* {@link SpottingSystem}, the only
 * `world.rng` consumer in the Rothermel pipeline; a draw here would shift
 * spotting's stream and desync it (the CA-only determinism golden would not catch
 * it). The *player command* layer (clicks → orders) is browser-only and
 * non-deterministic, living outside the determinism test like the terrain editor.
 *
 * A crew is muscle-limited (fatigue); an engine is water-limited — so it carries a
 * tank, not fatigue. It is NOT an {@link IgnitableEntity} (that seam is for
 * fuel-at-risk that burns and does not move); an engine moves and does not burn.
 */

/** A single player order for an engine. 4b engines do water knockdown only. */
export interface EngineOrder {
  readonly task: 'direct-attack';
  readonly x: number;
  readonly y: number;
}

export interface EngineOptions {
  /** Start cell x. */
  x: number;
  /** Start cell y. */
  y: number;
  /** Travel speed on easy, flat ground [cells/sec]. Fuel/slope slow it. */
  speed?: number;
  /** Tank capacity [litres]. Full at spawn. */
  capacityLiters?: number;
  /** Water applied (drawn from the tank) per second while knocking down [L/s]. */
  drawRateLps?: number;
  /** Seconds to refill a dry tank once on station at the refill point. */
  refillSeconds?: number;
  /** Static refill point (water tender / hydrant / dip). Defaults to the start cell. */
  refillX?: number;
  refillY?: number;
  /** Label suffix so several engines get distinct system names. */
  id?: string;
}

// --- sandbox tuning levers (documented; all deterministic) -------------------

/** Default flat-ground travel speed [cells/sec]. Faster than a crew on easy ground… */
const DEFAULT_SPEED = 0.12;
/** …but a road-biased vehicle pays a heavier off-road penalty than a crew on foot. */
const FUEL_RESISTANCE: Record<number, number> = {
  [Fuel.Nonburnable]: 1, // road — the engine's easy going
  [Fuel.Grass]: 1.2,
  [Fuel.Brush]: 2.5,
  [Fuel.Timber]: 4, // an engine barely makes headway through timber off-road
  [Fuel.CutLine]: 1, // a dozer/hand line is drivable
};
/** Upslope cost multiplier (a vehicle labours uphill more than a hand crew). */
const SLOPE_PENALTY = 4;
/** Default tank [L] — a Type-3 wildland engine carries ~500 gal ≈ 1900 L. */
const DEFAULT_CAPACITY = 1900;
/** Default draw [L/s] — ~180 s of continuous attack flow from a full tank. */
const DEFAULT_DRAW_LPS = 10.5;
/** Default refill time [s] — topping up from a tender/hydrant is minutes, not seconds. */
const DEFAULT_REFILL_SECONDS = 90;
/** Knockdown target [moisture fraction]. Higher than the crew's 0.6 — both zero ROS
 *  on contact (above any Anderson extinction moisture), but a wetter bed takes
 *  LONGER to dry back toward EMC, so the engine's line holds longer after it leaves.
 *  (Advisor note: "stronger" = coverage + persistence, not a harder instantaneous hit.) */
const KNOCKDOWN_MOISTURE = 0.9;
/** Knockdown footprint radius [cells] — a 5×5 patch, wider than the crew's 3×3. Still
 *  finite: a point engine cannot cover a wide front, so it too is flanked (doctrine). */
const KNOCKDOWN_RADIUS = 2;

export class Engine implements ISuppressionAgent {
  readonly agentType = 'engine';
  readonly name: string;

  private px: number;
  private py: number;
  private readonly travel_: TravelParams;
  private readonly orders: EngineOrder[] = [];

  private readonly capacity: number;
  private readonly drawRate: number;
  private readonly refillSeconds: number;
  private readonly refillX: number;
  private readonly refillY: number;

  /** Water remaining in the tank [L]. */
  private water: number;
  /** True while the engine has broken off to refill (driving to water or topping up). */
  private refilling = false;
  /** Seconds of top-up banked once on station at the refill point. */
  private refillProgress = 0;

  constructor(opts: EngineOptions) {
    this.px = opts.x;
    this.py = opts.y;
    this.travel_ = {
      speed: opts.speed ?? DEFAULT_SPEED,
      resistance: FUEL_RESISTANCE,
      slopePenalty: SLOPE_PENALTY,
    };
    this.capacity = opts.capacityLiters ?? DEFAULT_CAPACITY;
    this.drawRate = opts.drawRateLps ?? DEFAULT_DRAW_LPS;
    this.refillSeconds = opts.refillSeconds ?? DEFAULT_REFILL_SECONDS;
    this.refillX = opts.refillX ?? opts.x;
    this.refillY = opts.refillY ?? opts.y;
    this.water = this.capacity;
    this.name = `suppression:engine${opts.id ? `:${opts.id}` : ''}`;
  }

  // --- command surface (called by the browser command shell / tests) ---------

  /** Order the engine to hold a station with water. Sticky (re-wets each tick) until
   *  {@link standDown} or a new order replaces it; the reload cycle is automatic. */
  orderDirectAttack(x: number, y: number): void {
    // A fresh held station replaces any prior order (an engine holds one edge at a time).
    this.orders.length = 0;
    this.orders.push({ task: 'direct-attack', x, y });
  }

  /** Cancel the order and abort any in-progress refill — the engine stands by. Water
   *  level is preserved. */
  standDown(): void {
    this.orders.length = 0;
    this.refilling = false;
    this.refillProgress = 0;
  }

  get cellX(): number {
    return Math.round(this.px);
  }
  get cellY(): number {
    return Math.round(this.py);
  }
  get isIdle(): boolean {
    return this.orders.length === 0 && !this.refilling;
  }
  /** True while the engine has broken off its station to refill. */
  get isRefilling(): boolean {
    return this.refilling;
  }
  /** Water remaining [L]. */
  get waterLiters(): number {
    return this.water;
  }
  /** Water remaining as a 0..1 fraction of capacity (for a gauge readout). */
  get waterFraction(): number {
    return this.capacity > 0 ? this.water / this.capacity : 0;
  }

  /** The cell the engine is currently driving toward: its refill point while
   *  refilling, else the held station. Null when idle. */
  get targetCell(): { x: number; y: number } | null {
    if (this.refilling) return { x: this.refillX, y: this.refillY };
    if (this.orders.length === 0) return null;
    const o = this.orders[0];
    return { x: o.x, y: o.y };
  }

  // --- per-tick execution ----------------------------------------------------

  step(world: WorldState, dt: number): void {
    // A dry tank with work still to do breaks the engine off to refill. It resumes
    // the (still-queued, sticky) station automatically once topped up.
    if (this.water <= 0 && this.orders.length > 0) this.refilling = true;

    if (this.refilling) {
      this.runReload(world, dt);
      return;
    }

    if (this.orders.length === 0) return; // idle
    const order = this.orders[0];

    // Travel gates work, exactly as the crew: a tick that moves the engine is spent
    // driving; water only flows on ticks that begin with the engine on station.
    const r = advanceToward(world, this.px, this.py, order.x, order.y, this.travel_, dt);
    this.px = r.x;
    this.py = r.y;
    if (!r.arrived) return;

    this.workDirectAttack(world, order, dt);
  }

  /** Drive to the refill point and top the tank up over {@link refillSeconds}. */
  private runReload(world: WorldState, dt: number): void {
    const r = advanceToward(world, this.px, this.py, this.refillX, this.refillY, this.travel_, dt);
    this.px = r.x;
    this.py = r.y;
    if (!r.arrived) return; // still driving to water

    this.refillProgress += dt;
    if (this.refillProgress >= this.refillSeconds) {
      this.water = this.capacity;
      this.refilling = false;
      this.refillProgress = 0;
      // Next tick falls through to normal handling: it drives back to the still-queued
      // station and resumes knocking down.
    }
  }

  /**
   * Hold an edge with water: spike `moisture` toward saturation on the UNBURNED
   * cells in the footprint, and draw the tank down by one tick of flow. Wetting
   * unburned fuel drops its Rothermel ROS toward zero (moisture is read at the
   * destination cell the front spreads into); a spike on the burning cell would be a
   * no-op. The footprint is finite, so a point engine cannot cover a wide front — it
   * is flanked, which is why an engine *holds* rather than contains. Water flows (and
   * draws down) every on-station tick, whether or not the patch is already wet: that
   * finite tank is the whole 4b lever, and running it dry triggers the reload cycle.
   */
  private workDirectAttack(world: WorldState, order: EngineOrder, dt: number): void {
    const { width, height, layers } = world;
    const wetByte = fractionToByte(KNOCKDOWN_MOISTURE);
    for (let dy = -KNOCKDOWN_RADIUS; dy <= KNOCKDOWN_RADIUS; dy++) {
      for (let dx = -KNOCKDOWN_RADIUS; dx <= KNOCKDOWN_RADIUS; dx++) {
        const x = order.x + dx;
        const y = order.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = y * width + x;
        if (layers.fire.data[i] !== FireState.Unburned) continue; // wet unburned fuel only
        if (layers.moisture.data[i] < wetByte) layers.moisture.data[i] = wetByte;
      }
    }
    this.water = Math.max(0, this.water - this.drawRate * dt);
    // Held task: do not pop — the engine stays on station until stood down or dry.
  }
}
