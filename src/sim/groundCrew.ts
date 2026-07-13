import { FireState, type WorldState } from '../core/world';
import type { ISuppressionAgent } from '../models/ISuppressionAgent';
import type { IFuelModel } from '../models/IFuelModel';
import { fractionToByte } from '../core/moisture';
import { Fuel } from './basicFuelModel';

/**
 * Phase-4 slice 4a (`docs/plans/phase-4-firefighting.md`) — the first exercise of
 * the {@link ISuppressionAgent} seam and the phase's spine: a hand crew the player
 * commands to build containment line, set a backburn, or hold an edge with direct
 * attack.
 *
 * **Layer-only, exactly like spotting (plan §"layer-only").** The crew reads and
 * writes ONLY the data layers — `fuel` (→ {@link Fuel.CutLine}), `fire` (ignite for
 * a backburn), and `moisture` (a knockdown spike) — and NEVER touches a fire
 * model's private spread state or calls another system (Handoff §3.1). No §4.4
 * mechanic turns a Burning/Burned cell back toward Unburned; every one denies the
 * front *unburned* fuel at or ahead of the edge. That is what lets suppression work
 * whatever fire model is mounted.
 *
 * **Pipeline order is load-bearing:** `weather → moisture → suppression → fire →
 * spotting`. A knockdown must land in `moisture` *after* the drydown step and
 * *before* the fire model reads it this tick (so the drop protects the bed the fire
 * evaluates now); a backburn must ignite in time for the fire model to spread it
 * this tick. Suppression before moisture would let the same-tick drydown eat the drop.
 *
 * **Per-unit state lives on the agent** (position, order queue, partial line work,
 * fatigue) — private fields, precisely as {@link RothermelFireModel} privately holds
 * its `progress`. A `System` may hold private state; it just talks to *other*
 * systems only through layers. A crew is NOT an {@link IgnitableEntity}: that seam is
 * for fuel-at-risk (structures that burn and don't move); a crew moves and doesn't burn.
 *
 * **Determinism (Handoff §3.2).** Travel and work are pure arithmetic — **no
 * `world.rng` draw at all**. Beyond reproducibility this matters because the crew
 * steps *before* {@link SpottingSystem}, the only `world.rng` consumer in the
 * Rothermel pipeline; a draw here would shift spotting's stream and desync it. The
 * *player command* layer (clicks → orders) is browser-only and non-deterministic,
 * living outside the determinism test exactly like the terrain editor.
 */

/** What a crew does on arrival at an order's target cell. */
export type CrewTask = 'cut-line' | 'backburn' | 'direct-attack';

/** A single player order: do `task` at cell (`x`, `y`). */
export interface CrewOrder {
  readonly task: CrewTask;
  readonly x: number;
  readonly y: number;
}

export interface GroundCrewOptions {
  /** Start cell x. */
  x: number;
  /** Start cell y. */
  y: number;
  /** Travel speed on easy, flat ground [cells/sec]. Fuel/slope slow it (see below). */
  speed?: number;
  /** Label suffix so several crews get distinct system names. */
  id?: string;
}

// --- sandbox tuning levers (documented; all deterministic) -------------------

/** Default flat-ground travel speed [cells/sec]. ~2.4 m/s on 30 m cells. */
const DEFAULT_SPEED = 0.08;
/** Base seconds to cut one cell of line at zero fatigue (a §4.4 logistics lever). */
const SECONDS_PER_CELL = 8;
/** Fatigue gained per cell of line cut (0..1, capped). Raises seconds-per-cell. */
const FATIGUE_PER_CELL = 0.02;
/** At full fatigue, line takes (1 + this)× as long — the logistics cost climbs. */
const FATIGUE_SLOWDOWN = 1.0;
/** Slope cost: travel time scales by 1 + grade·this (upslope only). */
const SLOPE_PENALTY = 3;
/** Direct-attack knockdown target [moisture fraction] — comfortably above any
 *  Anderson dead moisture-of-extinction (~0.12–0.40), so ROS → 0 where it lands. */
const KNOCKDOWN_MOISTURE = 0.6;
/** Direct-attack footprint radius [cells]. A point crew wets a small patch; the
 *  front flanks it — which is precisely why a crew *holds* rather than contains. */
const KNOCKDOWN_RADIUS = 1;
/** Travel resistance by fuel id — heavy fuel slows a crew. Effective speed = speed / R. */
const FUEL_RESISTANCE: Record<number, number> = {
  [Fuel.Nonburnable]: 1, // road / rock / water — treat as easy going
  [Fuel.Grass]: 1,
  [Fuel.Brush]: 1.6,
  [Fuel.Timber]: 2.2,
  [Fuel.CutLine]: 1, // a cut line is walkable
};

export class GroundCrew implements ISuppressionAgent {
  readonly agentType = 'hand-crew';
  readonly name: string;

  private px: number;
  private py: number;
  private readonly speed: number;
  private readonly orders: CrewOrder[] = [];
  /** Seconds of work banked on the current cut-line cell. */
  private lineProgress = 0;
  /** 0..1; raises seconds-per-cell of line as it climbs (§4.4 logistics). */
  private fatigue = 0;

  constructor(
    private readonly fuel: IFuelModel,
    opts: GroundCrewOptions,
  ) {
    this.px = opts.x;
    this.py = opts.y;
    this.speed = opts.speed ?? DEFAULT_SPEED;
    this.name = `suppression:hand-crew${opts.id ? `:${opts.id}` : ''}`;
  }

  // --- command surface (called by the browser command shell / tests) --------

  /** Queue an order (FIFO). Cut-line/backburn complete and pop; direct-attack holds. */
  enqueue(order: CrewOrder): void {
    this.orders.push(order);
  }

  orderCutLine(x: number, y: number): void {
    this.enqueue({ task: 'cut-line', x, y });
  }
  orderBackburn(x: number, y: number): void {
    this.enqueue({ task: 'backburn', x, y });
  }
  orderDirectAttack(x: number, y: number): void {
    this.enqueue({ task: 'direct-attack', x, y });
  }

  /** Cancel all orders and drop partial line work — the crew stands down. */
  standDown(): void {
    this.orders.length = 0;
    this.lineProgress = 0;
  }

  get cellX(): number {
    return Math.round(this.px);
  }
  get cellY(): number {
    return Math.round(this.py);
  }
  get isIdle(): boolean {
    return this.orders.length === 0;
  }
  get currentTask(): CrewTask | null {
    return this.orders.length ? this.orders[0].task : null;
  }

  /** The cell of the order the crew is currently working toward, if any. */
  get targetCell(): { x: number; y: number } | null {
    if (this.orders.length === 0) return null;
    const o = this.orders[0];
    return { x: o.x, y: o.y };
  }

  // --- per-tick execution ---------------------------------------------------

  step(world: WorldState, dt: number): void {
    if (this.orders.length === 0) return; // idle
    const order = this.orders[0];

    // Travel gates work: a tick that moves the crew is spent traveling; work only
    // happens on ticks that begin with the crew already standing on the target.
    if (!this.travel(world, order, dt)) return;

    switch (order.task) {
      case 'cut-line':
        this.workCutLine(world, order, dt);
        return;
      case 'backburn':
        this.workBackburn(world, order);
        return;
      case 'direct-attack':
        this.workDirectAttack(world, order);
        return;
    }
  }

  /**
   * Advance toward the order's cell at the fuel/slope-adjusted speed. Returns true
   * iff the crew was already at the target at the start of the tick (so it may work
   * this tick); returns false while still en route (including the tick it arrives).
   */
  private travel(world: WorldState, order: CrewOrder, dt: number): boolean {
    const dx = order.x - this.px;
    const dy = order.y - this.py;
    const dist = Math.hypot(dx, dy);
    if (dist <= 1e-6) return true; // already on station

    const step = this.effectiveSpeed(world, dx, dy) * dt;
    if (step >= dist) {
      this.px = order.x;
      this.py = order.y;
    } else {
      this.px += (dx / dist) * step;
      this.py += (dy / dist) * step;
    }
    return false; // this tick was travel
  }

  /** Cells/sec here and now: base speed divided by fuel and upslope resistance. */
  private effectiveSpeed(world: WorldState, dx: number, dy: number): number {
    const { width, height, cellSize, layers } = world;
    const cx = clamp(Math.round(this.px), 0, width - 1);
    const cy = clamp(Math.round(this.py), 0, height - 1);
    const ci = cy * width + cx;

    const fuelR = FUEL_RESISTANCE[layers.fuel.data[ci]] ?? 1;

    // Upslope grade toward the next step cell (upslope-only, like Rothermel's slope).
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    let slopeR = 1;
    if (sx !== 0 || sy !== 0) {
      const nx = clamp(cx + sx, 0, width - 1);
      const ny = clamp(cy + sy, 0, height - 1);
      const run = Math.hypot(sx, sy) * cellSize;
      const rise = layers.elevation.data[ny * width + nx] - layers.elevation.data[ci];
      if (rise > 0) slopeR = 1 + (rise / run) * SLOPE_PENALTY;
    }
    return this.speed / (fuelR * slopeR);
  }

  private workCutLine(world: WorldState, order: CrewOrder, dt: number): void {
    const { width, layers } = world;
    const i = order.y * width + order.x;
    // Guard on Unburned (plan gotcha): cutting fuel from under a Burning cell gives
    // it residence time 0 → it flashes to Burned, a permanent spread source. If the
    // front already reached the cell, the line can't be built here — drop the order.
    if (layers.fire.data[i] !== FireState.Unburned) {
      this.orders.shift();
      this.lineProgress = 0;
      return;
    }

    this.lineProgress += dt;
    const needed = SECONDS_PER_CELL * (1 + this.fatigue * FATIGUE_SLOWDOWN);
    if (this.lineProgress >= needed) {
      layers.fuel.data[i] = Fuel.CutLine;
      this.fatigue = Math.min(1, this.fatigue + FATIGUE_PER_CELL);
      this.orders.shift();
      this.lineProgress = 0;
    }
  }

  private workBackburn(world: WorldState, order: CrewOrder): void {
    const { width, layers } = world;
    const i = order.y * width + order.x;
    // Ignite unburned, burnable fuel only — igniting a nonburnable cell has no
    // Rothermel bed and would flash straight to Burned (a stray permanent source).
    if (layers.fire.data[i] === FireState.Unburned && this.fuel.getParams(layers.fuel.data[i]).burnable) {
      layers.fire.data[i] = FireState.Burning;
      layers.burnElapsed.data[i] = 0;
    }
    this.orders.shift(); // one-shot: the player times and places it
  }

  /**
   * Hold an edge: spike `moisture` toward saturation on the UNBURNED cells in a
   * small footprint around the station. Moisture is read only at the *destination*
   * (unburned) cell the front spreads into (`rothermelFireModel.ts` §fuelBed), so a
   * spike on unburned fuel drops its ROS toward zero — a spike on the burning cell
   * would be a no-op. The footprint is small, so a point crew cannot cover a wide
   * front: the fire flanks the wet patch. That is the doctrine lesson — a hand crew
   * *holds*, it does not contain; the durable stop is the cut line. This order is
   * sticky (re-wets every tick) until {@link standDown} or a new order replaces it;
   * the moisture system dries the patch back toward EMC once the crew leaves.
   */
  private workDirectAttack(world: WorldState, order: CrewOrder): void {
    const { width, height, layers } = world;
    const wetByte = fractionToByte(KNOCKDOWN_MOISTURE);
    for (let dy = -KNOCKDOWN_RADIUS; dy <= KNOCKDOWN_RADIUS; dy++) {
      for (let dx = -KNOCKDOWN_RADIUS; dx <= KNOCKDOWN_RADIUS; dx++) {
        const x = order.x + dx;
        const y = order.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = y * width + x;
        if (layers.fire.data[i] !== FireState.Unburned) continue; // wet unburned fuel only
        // Never dry a cell that is already wetter (max), just raise dry fuel.
        if (layers.moisture.data[i] < wetByte) layers.moisture.data[i] = wetByte;
      }
    }
    // Held task: do not pop — the crew stays on station knocking down each tick.
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
