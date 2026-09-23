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
 * ### Scope (Stages 1–2)
 *
 * Advance, substepping, density control, barriers, seeding, rasterisation
 * (Stage 1), and **merging plus ring retirement** (Stage 2, §D6). **Not yet:**
 * crossover and loop removal for a *single* self-intersecting front (§D7,
 * Stage 3), and burnable enclaves, which are out of scope for the phase entirely
 * (§D8).
 *
 * **Merging here is grid-assisted, not a polygon-union transcription** — a
 * deliberate, documented reversal of §D6's "port FARSITE's `MergeFireRings`".
 * FARSITE's routine is bound to its `FireRing`/post-frontal area-apportionment
 * subsystem, which this sandbox does not model, and the raster the rings paint is
 * already their exact union (a cell ignites once). So instead of clipping two
 * polygons together, every cell records the {@link owner} that first painted it,
 * and a marker stepping onto another front's ground is *blocked* ({@link advance}):
 * two fronts that meet weld along their contact instead of running through each
 * other, and a front all of whose markers are blocked — enveloped by other burns,
 * or jammed against barriers and the map edge — has nowhere to grow and is
 * **retired** at the end of the tick. That retirement is the cost half of §D6:
 * without it a ring the burn has swallowed keeps recomputing an outward push
 * forever, and a preset throwing hundreds of embers accumulates hundreds of
 * ever-growing rings. The seam between two welded fronts is a stalled arc of
 * markers rather than a re-solved single polygon; no consumer reads the polygons,
 * so the distinction is invisible downstream.
 *
 * Determinism (§D9): rings advance in creation order (front ids are monotonic),
 * retirement filters in place preserving that order, points advance in ring order
 * from a pinned start vertex, and the seeding scan runs in cell-index order. No RNG —
 * nothing here wants one. `tests/huygens.test.ts` pins it by running the same
 * scenario twice and comparing a hash of the three output layers.
 */

/** A perimeter plus the per-marker scratch the current substep filled. */
interface Front extends Ring {
  /**
   * Creation-order id, stable for the front's whole life. Every cell records the
   * id of the **first** front to paint it ({@link HuygensFireModel.owner}); a
   * marker of front F stepping onto a cell some *other* front already owns is
   * interior to that front's burn and stops there — that stop, aggregated, is how
   * two perimeters that have grown together weld into one and how an enveloped
   * ring is detected and retired (§D6). Determinism (§D9) leans on this being
   * assigned in creation order.
   */
  id: number;
  /** Velocity [cells/s], one per vertex. */
  vx: number[];
  vy: number[];
  /** Fireline intensity [kW/m] and crown type of the marker's own motion. */
  fli: number[];
  crown: number[];
  /**
   * Did *any* marker have an open (unblocked) move somewhere this tick? A front
   * for which every marker was blocked — by the map edge, nonburnable fuel, or
   * another front's owned ground — is a geometric dead end: it has nowhere left to
   * grow, so it is retired at the end of the tick (§D6's cost half — otherwise a
   * ring enclosed by burnt ground keeps recomputing an outward push forever). A
   * merely *slow* front, whose markers sit still on their own or on open ground
   * without being rejected, is not blocked and is kept, because conditions
   * (wind, moisture) can still start it moving on a later tick.
   */
  open: boolean;
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
  /**
   * Retire a front once every marker is against a permanent wall (§D6). Default
   * true — the cost bound. `false` keeps every ring alive forever; it exists only
   * to measure what retirement is worth (a swallowed ring keeps recomputing an
   * outward push) and to pin that it holds the front count down, and is never a
   * mounted configuration.
   */
  retire?: boolean;
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
  private readonly retire: boolean;

  /** Perimeters, in creation order (§D9). */
  private fronts: Front[] = [];
  /** Next front id — monotonic, so ids order fronts by creation (§D9). */
  private nextFrontId = 0;
  /**
   * Per cell: which front (by {@link Front.id}) first accounted for this cell, or
   * `-1` for none. Set when a ring paints a cell or is seeded at one, and never
   * cleared — a burnt-over cell is still accounted for, so re-seeding it would
   * restart a fire on ash, and the *first* owner is the front whose intensity the
   * cell keeps.
   *
   * The owner is what turns overlapping rings into one fire without any polygon
   * clipping (§D6): a marker stepping onto another front's cell stops, so two
   * fronts that meet weld along their contact instead of burning through each
   * other, and a ring all of whose markers land on other fronts' ground is
   * enveloped and retired. The union those rings paint into `fire` was always
   * correct (a cell ignites once); ownership makes the *front* correct and the
   * *cost* bounded too.
   */
  private owner: Int32Array | null = null;

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
    this.retire = opts.retire ?? true;
  }

  step(world: WorldState, dt: number): void {
    const { width, layers } = world;
    const fire = layers.fire.data;
    const fuelL = layers.fuel.data;
    const burnElapsed = layers.burnElapsed.data;
    const intensity = layers.intensity.data;
    const crown = layers.crown.data;
    const behaviour = this.behaviour;

    if (this.owner === null || this.owner.length !== fire.length) {
      this.owner = new Int32Array(fire.length).fill(-1);
    }
    const owner = this.owner;

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

      if (owner[i] < 0) {
        const id = this.nextFrontId++;
        owner[i] = id;
        const x = i % width;
        const y = (i / width) | 0;
        this.fronts.push(makeFront(seedRing(x + 0.5, y + 0.5, this.seedRadius, this.seedVertices), id));
      }
    }
    if (this.fronts.length === 0) return;

    // ── 2. Advance, in substeps ──────────────────────────────────────────────
    // A front is retired at the end of the tick if it never found an open move —
    // clear the per-tick flag now, and let `advance` set it (§D6).
    for (const f of this.fronts) f.open = false;
    let remaining = dt;
    let advanced = false;
    for (let s = 0; s < MAX_SUBSTEPS && remaining > 1e-9; s++) {
      const maxSpeed = this.computeVelocities(world);
      if (!(maxSpeed > 0)) break;
      // FARSITE's `limgrow`: clamp the advance and decrement the remaining time.
      const sub = Math.min(remaining, this.maxAdvance / maxSpeed);
      this.advance(world, sub, fire, fuelL, intensity, crown, burnElapsed, owner);
      remaining -= sub;
      advanced = true;
    }

    // ── 3. Retire enveloped / dead-ended fronts (§D6) ────────────────────────
    // A front with no open move anywhere this tick has nowhere left to grow: its
    // markers are all against the map edge, nonburnable fuel, or ground another
    // front owns. Dropping it neither un-burns a cell (owner and `fire` keep
    // their values) nor lets it re-seed (its cells are owned), it only stops the
    // wasted per-tick recompute of a ring the burn has swallowed. Filtering in
    // place preserves creation order, so determinism (§D9) is untouched.
    //
    // **Only when `advance` actually ran.** On a tick where *no* marker anywhere
    // has speed — the whole fire wet above extinction, a rain pulse, a lone ember
    // in marginal fuel — the substep loop breaks before `advance`, so no front got
    // to set `open`. Retiring then would silently kill every fire for good (its
    // cells stay owned, so nothing re-seeds), even though a slow front is meant to
    // survive and resume when conditions turn. Blocking by a *wet* cell likewise
    // does not count against a front (see `advance`): only permanent walls do.
    if (this.retire && advanced && this.fronts.some((f) => !f.open)) {
      this.fronts = this.fronts.filter((f) => f.open);
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
    owner: Int32Array,
  ): void {
    const { width, height } = world;
    const moist = world.layers.moisture.data;
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
        const j = cx < 0 || cy < 0 || cx >= width || cy >= height ? -1 : cy * width + cx;
        // Two kinds of block, which must be told apart for retirement (§D6).
        //
        // *Permanent* walls — the map edge, nonburnable fuel, or ground some other
        // front already owns — a marker can never cross. The last is the weld: two
        // fronts that have grown together stop pushing into each other's burn
        // rather than running through it. A front whose every marker is against a
        // permanent wall has nowhere to go and is retired.
        const permanent =
          j < 0 ||
          !behaviour.burnableFuel(fuelL[j]) ||
          (owner[j] >= 0 && owner[j] !== f.id);
        // A *temporary* block is a burnable cell that just cannot carry fire yet —
        // wet above extinction, or retardant-pinned (§4c). The marker holds at the
        // wall exactly as the raster front stalls there, but the front stays
        // **open**: the band may dry or the retardant wash out, and it must be
        // able to cross then (`tests/huygens.test.ts` drydown gate). Only a
        // permanent wall counts a marker as dead.
        const wet = !permanent && !behaviour.carriesFire(fuelL[j], moist[j]);
        if (!permanent) f.open = true;
        if (permanent || wet) {
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
          // First front to touch a cell owns it (and, below, sets its intensity):
          // ownership is what lets a later front's markers recognise this ground
          // as already burning and weld to it rather than burn through (§D6).
          if (owner[i] < 0) owner[i] = f.id;
          if (fire[i] !== FireState.Unburned) return;
          // Never ignite a cell that cannot carry fire — nonburnable, or wet /
          // retardant-pinned above extinction. An edge segment between two dry
          // markers can still cross such a cell, so the paint gate has to be the
          // full `carriesFire`, not just `burnableFuel` (matching the raster
          // model's per-candidate `rate <= 0` skip).
          if (!behaviour.carriesFire(fuelL[i], moist[i])) return;
          fire[i] = FireState.Burning;
          burnElapsed[i] = 0;
          if (fli[k] > 0) {
            intensity[i] = fli[k];
            crown[i] = mc[k];
          } else {
            // The marker's own motion carried no intensity — its vertex sat on a
            // marginal or off-cell where {@link computeVelocities} bailed, yet the
            // segment it paints crossed a burnable cell. Give that cell its own
            // head-fire value now, in the same tick, rather than leaving a zero
            // for the next tick's fallback (§5c): spotting and the crown test read
            // `intensity` the moment this tick's fire model returns, and a zero
            // there reads as "no fire".
            const rf = this.fuel.getParams(fuelL[i]).rothermel;
            if (rf) this.recordHeadFire(world, i, rf);
          }
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

function makeFront(ring: Ring, id: number): Front {
  const n = ring.xs.length;
  return {
    id,
    xs: ring.xs,
    ys: ring.ys,
    vx: new Array(n).fill(0),
    vy: new Array(n).fill(0),
    fli: new Array(n).fill(0),
    crown: new Array(n).fill(0),
    open: false,
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
