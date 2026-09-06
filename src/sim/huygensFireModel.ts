import { FireState, type WorldState } from '../core/world';
import type { IFireModel } from '../models/IFireModel';
import type { IFuelModel } from '../models/IFuelModel';
import { metersPerSecToFtPerMin, ftPerMinToMetersPerSec } from './rothermel';
import { ellipseDimensions, richardsVelocity, type EllipseDimensions, type MarkerVelocity } from './richards';
import {
  densityControl,
  seedRing,
  traverseSegment,
  type Ring,
} from './perimeter';
import { SurfaceBehaviour, type SurfaceBehaviourOptions } from './surfaceBehaviour';

/**
 * Phase-11 fire model: the front is a **polygon of marker points** that each
 * advance by Richards' (1990) elliptical growth equations — FARSITE's mechanism —
 * and the polygon is rasterised into the same `fire` / `intensity` / `crown`
 * layers everything downstream already reads.
 *
 * ### What this buys over the raster front
 *
 * {@link RothermelFireModel} carries the fire as arrival-time accumulators along
 * 16 fixed rays. That gets the *directional law* exactly right (Phase 8) and the
 * *propagation* as right as a raster gets (Phase 8b), and what is left is a
 * discretisation floor rather than a modelling error: a cell can only ignite on
 * a tick edge, a front can only travel in 16 directions, and the accumulators
 * cost 16 floats per cell — 67 MB at `?size=1024`. A marker front has none of
 * those: it sits at a real-valued position, moves in whatever direction the
 * geometry points, and costs O(perimeter points) regardless of map size.
 *
 * ### The one thing that is *not* new
 *
 * **The directional law is unchanged.** FARSITE's `lb_ratio` is
 * character-for-character this repo's `lengthToBreadthRatio` (Anderson 1983, cap
 * 8 included), and its Alexander head/backing ratio is our `backingRate` in
 * disguise: `1/HB = (1−E)/(1+E)`. So the ellipse this model propagates is the
 * ellipse the raster model already reads rates off. Phase 11 changes only **how
 * the front is carried** (`docs/plans/phase-11-smooth-wavefront.md` §2b).
 *
 * ### The contract with the rest of the sim
 *
 * The perimeter is model-private state, exactly as `progress`/`bedCache` are for
 * the raster model. Geometry never enters `Layers` — spotting, stats,
 * suppression and the renderer keep reading the same typed arrays and never
 * learn that vertices exist (§3).
 *
 * Each tick: seed perimeters for any externally-lit cell that no ring accounts
 * for → advance markers in continuous space, in substeps → rasterise the swept
 * band → write `fire`, and `intensity` / `crown` / `burnElapsed` on the cells
 * that flipped, in the same places the raster model writes them.
 *
 * ### Stage 1 scope
 *
 * Advance, substepping, density control, barriers, seeding and rasterisation.
 * **Not yet:** merging two perimeters that have grown together (§D6), crossover
 * and loop removal (§D7), or burnable enclaves, which are declared out of scope
 * for the phase entirely (§D8). Until merging lands, two rings that overlap keep
 * burning through each other's ground; the raster they paint is still correct
 * (a cell ignites once and stays ignited) but the *shape* of an overlap is not.
 *
 * **The sharper reason not to mount this on a preset with spotting is cost, not
 * shape.** {@link fronts} is never retired, and burning does not change a cell's
 * fuel id — so a marker sitting inside the burn scar still passes the burnable
 * test and keeps moving, and a ring wholly enclosed by burnt ground expands
 * forever. The output stays correct, because painting short-circuits on an
 * already-ignited cell; the *work* does not, and a preset throwing hundreds of
 * embers accumulates hundreds of ever-growing rings. Retiring a ring is properly
 * part of merging, which is why they are one stage.
 *
 * Determinism (§D9): rings advance in creation order, points in ring order from
 * a pinned start vertex, and the seeding scan runs in cell-index order. No RNG —
 * nothing here wants one. `tests/huygens.test.ts` pins it by running the same
 * scenario twice and comparing a hash of the three output layers.
 */

/** A perimeter plus the per-marker scratch the current substep filled. */
interface Front extends Ring {
  /** Velocity [cells/s], one per vertex. */
  vx: number[];
  vy: number[];
  /** Fireline intensity [kW/m] and crown type of the marker's own motion. */
  fli: number[];
  crown: number[];
}

export interface HuygensFireModelOptions extends SurfaceBehaviourOptions {
  /**
   * Target spacing between markers, in cells. Default 0.5.
   *
   * It is a **rasterising** bound, not an aesthetic one: an edge much longer
   * than half a cell can straddle a cell the sweep then fails to paint. Density
   * control holds edges in `[spacing/2, spacing]`.
   */
  markerSpacing?: number;
  /**
   * Cap on how far a marker may advance in one substep, in cells. Default 0.5.
   *
   * **This is the containment mechanism, and it is FARSITE's own**
   * (`Mechanix::limgrow`, `fsxwmech.cpp:617`, which caps at the distance
   * resolution and decrements the remaining time). A marker advancing `R·dt`
   * unchecked can step clean over a 30 m containment line in one tick; capped at
   * half a cell it must land *inside* the line at some substep, where the fuel
   * test stops it. That, plus the rule that rasterisation never ignites a
   * nonburnable cell, is what keeps the Phase-4 doctrine meaning something
   * (§D4).
   *
   * Worth knowing how often it actually fires: every mounted path steps at
   * `dt = 1 s` (`main.ts` `DT`, `sim.run(steps, 1)`, `tools/profile.ts`), and at
   * 30 m cells a marker would have to run at 15 m/s to reach the cap — so on the
   * shipped presets the loop runs once and the cap costs nothing. It is not
   * load-bearing for *cost*; it is load-bearing for *correctness*, and a
   * scenario with a coarser `dt` or a finer `cellSize` will exercise it.
   */
  maxAdvance?: number;
  /** Radius of a freshly seeded ring, in cells. Default 0.5 — one cell across. */
  seedRadius?: number;
  /** Vertices in a freshly seeded ring. Default 16. */
  seedVertices?: number;
}

/** Hard ceiling on substeps per tick — a fire model that hangs is worse than one that lags. */
const MAX_SUBSTEPS = 64;

export class HuygensFireModel implements IFireModel {
  readonly name = 'fire:huygens';

  private readonly behaviour: SurfaceBehaviour;
  private readonly markerSpacing: number;
  private readonly maxAdvance: number;
  private readonly seedRadius: number;
  private readonly seedVertices: number;

  /** Perimeters, in creation order (§D9). */
  private readonly fronts: Front[] = [];
  /**
   * Per cell: does some perimeter already account for this cell? Set when a ring
   * paints a cell or is seeded at one, and never cleared — a burnt-over cell is
   * still accounted for, and re-seeding it would restart a fire on ash.
   */
  private claimed: Uint8Array | null = null;

  // Scratch reused across markers.
  private readonly dim: EllipseDimensions = { a: 0, b: 0, c: 0 };
  private readonly vel: MarkerVelocity = { vx: 0, vy: 0 };
  private newX: number[] = [];
  private newY: number[] = [];

  constructor(
    private readonly fuel: IFuelModel,
    opts: HuygensFireModelOptions = {},
  ) {
    this.behaviour = new SurfaceBehaviour(fuel, opts);
    this.markerSpacing = opts.markerSpacing ?? 0.5;
    this.maxAdvance = opts.maxAdvance ?? 0.5;
    this.seedRadius = opts.seedRadius ?? 0.5;
    this.seedVertices = opts.seedVertices ?? 16;
  }

  step(world: WorldState, dt: number): void {
    const { width, layers } = world;
    const fire = layers.fire.data;
    const fuelL = layers.fuel.data;
    const burnElapsed = layers.burnElapsed.data;
    const intensity = layers.intensity.data;
    const crown = layers.crown.data;
    const behaviour = this.behaviour;

    if (this.claimed === null || this.claimed.length !== fire.length) {
      this.claimed = new Uint8Array(fire.length);
    }
    const claimed = this.claimed;

    // ── 1. Burnout, the externally-lit intensity fallback, and seeding ───────
    //
    // One linear pass, which is the same order of work the raster model's
    // candidate dilation does. It has to be a scan: other systems (the ignition
    // tool, spotting embers, a backburn) write `fire` directly, and the only way
    // to notice is to look (§D5 — the raster model reasons identically about
    // `intensity[i] === 0` on an externally-lit cell).
    for (let i = 0; i < fire.length; i++) {
      if (fire[i] !== FireState.Burning) continue;
      const rf = this.fuel.getParams(fuelL[i]).rothermel;

      if (intensity[i] === 0 && rf) this.recordHeadFire(world, i, rf);

      // Burnout is cosmetic flame duration (Albini residence time tau = 384/sigma),
      // independent of spread — unchanged from the raster model (§D10).
      burnElapsed[i] += dt;
      if (burnElapsed[i] >= behaviour.residenceSec(fuelL[i], rf)) fire[i] = FireState.Burned;

      if (claimed[i] === 0) {
        claimed[i] = 1;
        const x = i % width;
        const y = (i / width) | 0;
        this.fronts.push(makeFront(seedRing(x + 0.5, y + 0.5, this.seedRadius, this.seedVertices)));
      }
    }
    if (this.fronts.length === 0) return;

    // ── 2. Advance, in substeps ──────────────────────────────────────────────
    let remaining = dt;
    for (let s = 0; s < MAX_SUBSTEPS && remaining > 1e-9; s++) {
      const maxSpeed = this.computeVelocities(world);
      if (!(maxSpeed > 0)) break;
      // FARSITE's `limgrow`: clamp the advance and decrement the remaining time.
      const sub = Math.min(remaining, this.maxAdvance / maxSpeed);
      this.advance(world, sub, fire, fuelL, intensity, crown, burnElapsed, claimed);
      remaining -= sub;
    }
  }

  /**
   * Fill every marker's velocity and the fire behaviour along it, and return the
   * fastest speed [cells/s] found — which is what sizes the substep.
   *
   * The tangent is the **central difference** `previous − next`
   * (`fsxwmech.cpp:168`). FARSITE additionally re-projects it when the two
   * adjacent segments differ in length, to correct an angular bias
   * (`fsxwmech.cpp:174–217`); that correction is not transcribed here, because
   * density control holds neighbouring edges inside a factor of two of each
   * other and the bias it corrects is second-order at that spacing. Stated
   * rather than silently omitted.
   */
  private computeVelocities(world: WorldState): number {
    const { width, height, cellSize, layers } = world;
    const fuelL = layers.fuel.data;
    const moist = layers.moisture.data;
    const windU = layers.windU.data;
    const windV = layers.windV.data;
    const canopyL = layers.canopy.data;
    const elev = layers.elevation.data;
    const behaviour = this.behaviour;
    let maxSpeed = 0;

    for (const f of this.fronts) {
      const { xs, ys, vx, vy, fli, crown } = f;
      const n = xs.length;
      for (let k = 0; k < n; k++) {
        vx[k] = 0;
        vy[k] = 0;
        fli[k] = 0;
        crown[k] = 0;

        const px = xs[k];
        const py = ys[k];
        const cx = Math.floor(px);
        const cy = Math.floor(py);
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
        const i = cy * width + cx;
        const fp = this.fuel.getParams(fuelL[i]);
        const rf = fp.rothermel;
        if (!fp.burnable || !rf) continue;

        const prev = k === 0 ? n - 1 : k - 1;
        const next = k === n - 1 ? 0 : k + 1;
        const tx = xs[prev] - xs[next];
        const ty = ys[prev] - ys[next];
        if (tx === 0 && ty === 0) continue;

        // Everything about the cell, once: bed, wind reduction, crown proxy,
        // gradient, the wind-slope resultant and its ellipse.
        const bed = behaviour.surfaceBedFor(fuelL[i], rf, moist[i]);
        const waf = behaviour.midflameFactor(fuelL[i], rf, canopyL[i]);
        const fm10 = behaviour.crownBedFor(canopyL[i], moist[i]);
        const cbd = behaviour.cbdFor(canopyL[i]);
        behaviour.cellGradient(elev, i, cx, cy, width, height, cellSize);
        const wu = windU[i];
        const wv = windV[i];
        const wm = Math.sqrt(wu * wu + wv * wv);
        behaviour.prepareCellEllipse(
          bed, fm10, cbd, rf, wm,
          wm > 0 ? wu / wm : 0,
          wm > 0 ? wv / wm : 0,
          waf, behaviour.grad.tan, behaviour.grad.ux, behaviour.grad.uy,
        );

        // Richards, in cells per second: the head rate is ft/min on the cell
        // record, and a cell is `cellSize` metres across.
        const c = behaviour.cell;
        const headCells = ftPerMinToMetersPerSec(c.headRate) / cellSize;
        if (!(headCells > 0)) continue;
        const dim = ellipseDimensions(headCells, c.ecc, this.dim);
        const v = richardsVelocity(dim, c.headUx, c.headUy, tx, ty, this.vel);
        const speed = Math.hypot(v.vx, v.vy);
        if (!(speed > 0)) continue;

        // The marker's own outward speed is what its fireline intensity is built
        // from, and what the crown test reads (see `markerBehaviour`). A crown
        // run comes back faster than the surface fire, so the velocity is
        // rescaled to it — same direction, the crown's rate.
        const surfFtMin = metersPerSecToFtPerMin(speed * cellSize);
        const rateCells = behaviour.markerBehaviour(surfFtMin, tx, ty) / cellSize;
        const scale = rateCells / speed;
        vx[k] = v.vx * scale;
        vy[k] = v.vy * scale;
        fli[k] = behaviour.crownOut.intensity;
        crown[k] = behaviour.crownOut.type;
        if (rateCells > maxSpeed) maxSpeed = rateCells;
      }
    }
    return maxSpeed;
  }

  /**
   * Move every marker by `sub` seconds, paint the ground it swept, and re-space
   * the perimeter.
   *
   * **Two guards keep a barrier a barrier** (§D4). A marker whose new position
   * lands in nonburnable fuel does not move this substep — FARSITE does the same
   * with explicit barrier polygons in `fsxwbar.cpp`, and a fuel-layer test is
   * that same thing on our data model. And the paint below **never ignites a
   * nonburnable cell**, so a polygon bulging over a rock island still leaves the
   * island unburned.
   *
   * **Why painting the band cannot leave holes.** Each marker paints the path
   * from its old position to its new one, and the edge to its neighbour. The
   * region actually swept is the quad between the old edge and the new one, and
   * three of its four sides get painted (the fourth was painted last substep).
   * That quad is at most `maxAdvance` thick — half a cell — and a strip half a
   * cell thick cannot contain a whole 1×1 cell, so nothing inside it is missed
   * however long the edge is. This is why the paint runs on the pre-density
   * connectivity: every painted segment then belongs to a marker with a defined
   * intensity, and no inserted vertex has to invent one.
   */
  private advance(
    world: WorldState,
    sub: number,
    fire: Uint8Array,
    fuelL: Uint8Array,
    intensity: Float32Array,
    crown: Uint8Array,
    burnElapsed: Float32Array,
    claimed: Uint8Array,
  ): void {
    const { width, height } = world;
    const behaviour = this.behaviour;
    const newX = this.newX;
    const newY = this.newY;

    for (const f of this.fronts) {
      const { xs, ys, vx, vy, fli, crown: mc } = f;
      const n = xs.length;
      newX.length = n;
      newY.length = n;

      for (let k = 0; k < n; k++) {
        const nx = xs[k] + vx[k] * sub;
        const ny = ys[k] + vy[k] * sub;
        const cx = Math.floor(nx);
        const cy = Math.floor(ny);
        // Off the map, or into fuel that will not carry: stay put. (FARSITE's
        // `limgrow` likewise pins a point that would leave the landscape.)
        if (
          cx < 0 || cy < 0 || cx >= width || cy >= height ||
          !behaviour.burnableFuel(fuelL[cy * width + cx])
        ) {
          newX[k] = xs[k];
          newY[k] = ys[k];
        } else {
          newX[k] = nx;
          newY[k] = ny;
        }
      }

      for (let k = 0; k < n; k++) {
        const next = k === n - 1 ? 0 : k + 1;
        const paint = (px: number, py: number): void => {
          if (px < 0 || py < 0 || px >= width || py >= height) return;
          const i = py * width + px;
          claimed[i] = 1;
          if (fire[i] !== FireState.Unburned) return;
          if (!behaviour.burnableFuel(fuelL[i])) return;
          fire[i] = FireState.Burning;
          burnElapsed[i] = 0;
          intensity[i] = fli[k];
          crown[i] = mc[k];
        };
        // The marker's own path...
        traverseSegment(xs[k], ys[k], newX[k], newY[k], paint);
        // ...and the edge to its neighbour, at the new positions.
        traverseSegment(newX[k], newY[k], newX[next], newY[next], paint);
      }

      for (let k = 0; k < n; k++) {
        xs[k] = newX[k];
        ys[k] = newY[k];
      }
      densityControl(f, this.markerSpacing / 2, this.markerSpacing);
      resizeScratch(f);
    }
  }

  /**
   * An externally-lit cell (ignition tool, ember, backburn) has no arriving
   * front and hence no recorded intensity: give it its own head-fire values
   * once, so every burning cell carries a defined value for readers. Byte-for-byte
   * the reasoning `RothermelFireModel` applies to the same case.
   */
  private recordHeadFire(world: WorldState, i: number, rf: NonNullable<ReturnType<IFuelModel['getParams']>['rothermel']>): void {
    const { width, height, cellSize, layers } = world;
    const behaviour = this.behaviour;
    const fuelL = layers.fuel.data;
    const moist = layers.moisture.data;
    const canopyL = layers.canopy.data;
    const windU = layers.windU.data;
    const windV = layers.windV.data;
    const x = i % width;
    const y = (i / width) | 0;

    const bed = behaviour.surfaceBedFor(fuelL[i], rf, moist[i]);
    const waf = behaviour.midflameFactor(fuelL[i], rf, canopyL[i]);
    const speed = Math.hypot(windU[i], windV[i]);
    const fm10 = behaviour.crownBedFor(canopyL[i], moist[i]);
    const cbd = behaviour.cbdFor(canopyL[i]);
    behaviour.cellGradient(layers.elevation.data, i, x, y, width, height, cellSize);
    behaviour.prepareCellEllipse(
      bed, fm10, cbd, rf, speed,
      speed > 0 ? windU[i] / speed : 0,
      speed > 0 ? windV[i] / speed : 0,
      waf, behaviour.grad.tan, behaviour.grad.ux, behaviour.grad.uy,
    );
    behaviour.ellipticalDirection(1); // the head of its own ellipse
    layers.intensity.data[i] = behaviour.crownOut.intensity;
    layers.crown.data[i] = behaviour.crownOut.type;
  }

  /** The perimeters, for tests and measurement harnesses. Not read by any system. */
  get perimeters(): readonly Ring[] {
    return this.fronts;
  }
}

function makeFront(ring: Ring): Front {
  const n = ring.xs.length;
  return {
    xs: ring.xs,
    ys: ring.ys,
    vx: new Array(n).fill(0),
    vy: new Array(n).fill(0),
    fli: new Array(n).fill(0),
    crown: new Array(n).fill(0),
  };
}

/** Keep the per-marker scratch in step with a ring density control has resized. */
function resizeScratch(f: Front): void {
  const n = f.xs.length;
  f.vx.length = n;
  f.vy.length = n;
  f.fli.length = n;
  f.crown.length = n;
}
