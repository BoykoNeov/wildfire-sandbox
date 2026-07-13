import type { WorldState } from '../core/world';

/**
 * Shared travel substrate for {@link ISuppressionAgent} ground units (Phase-4).
 * The plan (`docs/plans/phase-4-firefighting.md` §4b) says engines use the "same
 * travel/work substrate as the crew"; rather than couple the two agents through a
 * class hierarchy, the movement math lives here as **pure functions** both call
 * with their own {@link TravelParams}. A hand crew and an engine genuinely differ
 * in resistance profile (a vehicle is road-biased and pays a heavier off-road
 * penalty), so parameterising is the natural home anyway.
 *
 * **Determinism (Handoff §3.2).** Every function here is pure arithmetic — **no
 * `world.rng` draw**. This is load-bearing: suppression agents step *before*
 * {@link SpottingSystem}, the only `world.rng` consumer in the Rothermel pipeline,
 * so a draw here would shift spotting's stream and silently desync it (the
 * CA-only determinism golden would not catch it).
 */

/** Per-agent travel tuning. All deterministic sandbox levers. */
export interface TravelParams {
  /** Base travel speed on easy, flat ground [cells/sec]. */
  readonly speed: number;
  /** Travel resistance by fuel id — heavier fuel slows the unit (effective speed = speed / R). */
  readonly resistance: Record<number, number>;
  /** Upslope cost: travel time scales by 1 + grade·this (upslope only, like Rothermel's slope). */
  readonly slopePenalty: number;
}

export interface TravelResult {
  /** New position after this tick's movement. */
  readonly x: number;
  readonly y: number;
  /**
   * True iff the unit was **already standing on the target at the start of the
   * tick** — i.e. it may spend this tick working. False while still en route,
   * *including the tick it snaps onto the target* (so the arrival tick is spent
   * travelling and work begins the tick after). This preserves the crew's
   * "travel gates work" timing.
   */
  readonly arrived: boolean;
}

/** Cells/sec here and now: base speed divided by fuel and upslope resistance. */
export function effectiveSpeed(
  world: WorldState,
  px: number,
  py: number,
  dx: number,
  dy: number,
  params: TravelParams,
): number {
  const { width, height, cellSize, layers } = world;
  const cx = clamp(Math.round(px), 0, width - 1);
  const cy = clamp(Math.round(py), 0, height - 1);
  const ci = cy * width + cx;

  const fuelR = params.resistance[layers.fuel.data[ci]] ?? 1;

  // Upslope grade toward the next step cell (upslope-only, like Rothermel's slope).
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let slopeR = 1;
  if (sx !== 0 || sy !== 0) {
    const nx = clamp(cx + sx, 0, width - 1);
    const ny = clamp(cy + sy, 0, height - 1);
    const run = Math.hypot(sx, sy) * cellSize;
    const rise = layers.elevation.data[ny * width + nx] - layers.elevation.data[ci];
    if (rise > 0) slopeR = 1 + (rise / run) * params.slopePenalty;
  }
  return params.speed / (fuelR * slopeR);
}

/**
 * Advance a unit at (`px`,`py`) toward (`tx`,`ty`) by one tick at the
 * fuel/slope-adjusted speed. Returns the new position and whether the unit was
 * already on station at the *start* of the tick (see {@link TravelResult.arrived}).
 */
export function advanceToward(
  world: WorldState,
  px: number,
  py: number,
  tx: number,
  ty: number,
  params: TravelParams,
  dt: number,
): TravelResult {
  const dx = tx - px;
  const dy = ty - py;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1e-6) return { x: px, y: py, arrived: true }; // already on station

  const step = effectiveSpeed(world, px, py, dx, dy, params) * dt;
  if (step >= dist) return { x: tx, y: ty, arrived: false }; // snaps on this (travel) tick
  return { x: px + (dx / dist) * step, y: py + (dy / dist) * step, arrived: false };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
