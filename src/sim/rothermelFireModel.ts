import { FireState, type WorldState } from '../core/world';
import type { IFireModel } from '../models/IFireModel';
import type { IFuelModel } from '../models/IFuelModel';
import type { RothermelFuel } from '../models/IFuelModel';
import { byteToFraction } from '../core/moisture';
import { ANDERSON_13, deadFuelBed, fuelBed } from './anderson13';
import {
  canopyBulkDensity,
  canopyCoverFraction,
  DEFAULT_CANOPY_STAND,
  type CanopyStand,
} from './canopyStand';
import { unshelteredWaf, windAdjustmentFactor } from './windAdjustment';
import {
  CROWN_WIND_REDUCTION,
  CrownFire,
  MIN_CROWN_CBD,
  evaluateCrownFire,
  type CrownInputs,
  type CrownResult,
} from './crownFire';
import {
  btuPerFtSecToKwPerM,
  characteristicSAV,
  flameResidenceTime,
  ftPerMinToMetersPerSec,
  metersPerSecToFtPerMin,
  prepareFuelBed,
  spreadFromIntermediates,
  windFactorFrom,
  type BedIntermediates,
  type SpreadResult,
} from './rothermel';
import {
  FT_PER_MIN_TO_MPH,
  crownLengthToBreadthRatio,
  eccentricity,
  effectiveWindSpeed,
  ellipticalRate,
  lengthToBreadthRatio,
  windSlopeResultant,
  type WindSlopeResultant,
} from './fireEllipse';

// 8-neighbour offsets and their cell-distances (cardinals = 1, diagonals = √2).
const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NY = [-1, -1, -1, 0, 0, 1, 1, 1];
const NDIST = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

/** Default live-fuel moisture [fraction] — 100%, a green-but-not-peak baseline. */
const DEFAULT_LIVE_MOISTURE = 1.0;
/** Rothermel-1991's crown proxy fuel bed: Anderson FM10. */
const FM10 = ANDERSON_13.get(10)!;

/**
 * What the world's `windU/windV` field means to this model.
 *  - `'midflame'` (default, the Phase-2 §D3 convention): the layer already *is*
 *    the wind at flame height; used as-is. Every existing test is authored this way.
 *  - `'open'`: the layer is the **20-ft open wind** (what a forecast reports); the
 *    model reduces it to midflame per cell with the Albini–Baughman wind adjustment
 *    factor (`windAdjustment.ts`) — deep beds keep more of it, a tree canopy
 *    shelters the surface fuel to a fraction. This is the physically honest
 *    setting for a scenario authored from reported wind speeds.
 */
export type WindReference = 'midflame' | 'open';

/**
 * How the front's rate varies with direction.
 *  - `'elliptical'` (default, Phase 8): wind and slope combine **once per cell**
 *    as vectors into a single head rate and direction of maximum spread, and
 *    every other direction is read off the spread ellipse at its focus,
 *    `R(θ) = R_head·(1−E)/(1−E·cos θ)` (Anderson 1983 length-to-breadth,
 *    BehavePlus `SurfaceFire::calculateSpreadRateAtVector`). This is what
 *    operational fire science computes; see `src/sim/fireEllipse.ts`.
 *  - `'perDirection'`: the Phase-2 law — project the wind onto each neighbour
 *    ray and run Rothermel with that reduced wind, combining wind and slope per
 *    ray. Kept because it is what the Phase-2..7 tests were authored against and
 *    it makes the two laws byte-comparable, but it is **not** in any source: it
 *    hands every direction more than 90° off the wind the full no-wind R₀, so a
 *    fire backs into the wind far too eagerly.
 */
export type SpreadShape = 'elliptical' | 'perDirection';

/** Construction options. A bare number is accepted as `liveMoisture` (legacy form). */
export interface RothermelFireModelOptions {
  /**
   * Live-fuel moisture [fraction] applied to every live particle when the bed is
   * assembled (the world moisture layer is dead-only — plan §D6). A scenario-level
   * scalar; 1.0 = 100%, a defensible "green live fuel" default that lets the
   * live-bearing shrub models carry. A single value for both live herb and woody.
   */
  liveMoisture?: number;
  /** See {@link WindReference}. Default `'midflame'`. */
  windReference?: WindReference;
  /** Canopy structure for wind sheltering and crown fire. Default {@link DEFAULT_CANOPY_STAND}. */
  canopy?: CanopyStand;
  /**
   * Enable the crown-fire transition (`crownFire.ts`): surface fire whose
   * intensity reaches Van Wagner's I_0 under a canopy torches or runs as a crown
   * fire, spreading at the Rothermel-1991 crown rate. Default `true` — a stand
   * with canopy crowns when it should; set `false` for a surface-only model.
   */
  crownFire?: boolean;
  /** See {@link SpreadShape}. Default `'elliptical'`. */
  spreadShape?: SpreadShape;
}

/**
 * Phase-2 fire model: a cellular automaton whose front speed *is* the Rothermel
 * rate of spread (Phase-2 plan §D4). No RNG — spread is deterministic arithmetic,
 * so a seed still reproduces a run byte-for-byte.
 *
 * **Front as discretized arrival time.** Each unburned cell carries a `progress`
 * accumulator in [0, 1). Every tick it advances by the *fastest* arriving front:
 *
 *   progress[i] += max over ignited neighbours n of  ROS(i, n→i) / (dist·cellSize) · dt
 *
 * where `ROS(i, n→i)` is the Rothermel ROS for cell `i`'s own fuel bed with wind
 * and slope projected onto the neighbour→cell direction. When `progress ≥ 1` the
 * cell ignites. A cell crossing one cell of width `cellSize` at rate `ROS` takes
 * `cellSize/ROS` seconds, so the measured front speed equals `ROS` along every
 * neighbour ray (cardinal and diagonal alike — `dist` is in the denominator).
 * `tests/spread-ros.test.ts` is the acceptance gate for this.
 *
 * **Why MAX, not the sum the first plan sketch used (§D4 amendment).** Summing
 * over neighbours overspeeds a planar front by 1+√2 ≈ 2.41× (one cardinal + two
 * diagonal sources), so the measured speed would not equal ROS. The front
 * physically arrives from the *fastest* direction — a min-arrival-time process —
 * and `max` is the forward-Euler discretization of exactly that. This serves
 * §D4's goal ("front speed *is* the ROS"); it does not reverse it.
 *
 * **Why ignited sources include Burned cells (§D4 amendment).** Flame residence
 * `τ = 384/σ` is seconds (~7 s for grass), but on a coarse grid one cell takes
 * many minutes to cross at a realistic no-wind ROS. If only *currently-burning*
 * cells seeded the front it would stall and die the instant a source burned out.
 * A cell that has *ever* ignited keeps pushing the front, which is the arrival-
 * time view; burnout (`Burning → Burned`) is then purely the cosmetic flame
 * duration and is decoupled from spread.
 *
 * **Fireline intensity and crown state are output layers.** When a cell ignites,
 * the Byram fireline intensity of the fastest arriving direction is written to
 * `layers.intensity` (kW/m) and its crown-fire type to `layers.crown` — the
 * front's own record of how it burned into each cell. Externally-lit cells
 * (ignition tool, ember, backburn) have no arriving front; they get their
 * head-fire values (own bed, local wind magnitude, flat) on their first burning
 * tick. Nothing else writes these layers (Handoff §3.1); spotting and the
 * renderer only read them.
 *
 * **Crown fire — the second stacked layer (handoff §2.1).** Per direction, the
 * surface result is passed through `evaluateCrownFire`: if the surface intensity
 * reaches Van Wagner's I_0 for the scenario's canopy stand (crown base height,
 * foliar moisture), the direction's rate becomes the crown-blended rate (surface
 * → Rothermel-1991 active rate by crown fraction burned) and its intensity adds
 * the canopy fuel consumed. The FM10 proxy bed the 1991 correlation needs is
 * assembled once per candidate cell, at the cell's own dead/live moisture, and
 * driven by 0.4 × the 20-ft wind — under the `'midflame'` convention the 20-ft
 * wind is backed out through the surface fuel's own unsheltered WAF. Canopy
 * bulk density comes from the cell's canopy byte × the stand's maximum, so
 * grass (CBD ≈ 0.01) never crowns and a canopy byte of 0 short-circuits the
 * whole evaluation. Everything stays inside `step(world, dt)`: no new seam, no
 * per-cell virtual calls.
 *
 * **Elliptical directional spread (Phase 8, the default).** Rothermel's rate is a
 * *head-fire* rate — the speed in one direction. Under `spreadShape:
 * 'elliptical'` the model computes that direction properly, once per cell: the
 * wind factor along the wind and the slope factor up the cell's own gradient are
 * added as **vectors** (`R_head = R₀ + |R₀φ_w·ŵ + R₀φ_s·ŝ|`), the resultant is
 * back-solved to an effective wind speed, and that gives an Anderson-1983
 * length-to-breadth ratio and hence the eccentricity of the spread ellipse. Each
 * of the eight rays then reads its rate off that ellipse at its focus,
 * `R(θ) = R_head·(1−E)/(1−E·cos θ)`. One Rothermel evaluation per cell replaces
 * eight, and a fire finally backs into the wind at `(1−E)/(1+E)` of its head rate
 * instead of at R₀. `src/sim/fireEllipse.ts` holds the ported formulas and
 * `docs/plans/phase-8-elliptical-spread.md` the reasoning; `spreadShape:
 * 'perDirection'` keeps the Phase-2 law.
 *
 * Two consequences worth knowing. **Slope is a per-cell gradient** (central
 * differences on `elevation`, edge-clamped) rather than the per-ray rise the old
 * law used, because the ellipse needs one slope vector per site — so a cell
 * spreads fastest uphill even when its ignited neighbour lies off to one side.
 * And **crown fire is still evaluated per direction**: the Van Wagner I₀ test
 * reads the direction's own elliptical intensity, so a fire can crown at its head
 * and stay a surface fire on its flanks. The FM10 crown proxy gets its own
 * ellipse (Rothermel-1991 `LB = 1 + 0.125·U₂₀`) about the same head direction.
 *
 * Determinism: sources are read from the pre-tick `fire` buffer (double-buffered
 * like {@link CaFireModel}); each cell writes only its own `progress`. So the
 * sweep is order-independent and reproducible.
 *
 * Conventions (documented per plan §D2/§D3):
 *  - World wind (`windU/windV`) is in m/s, projected onto the spread direction.
 *    By default it is read as **midflame** wind (§D3); with `windReference:
 *    'open'` it is the 20-ft open wind and is reduced to midflame per cell by the
 *    Albini–Baughman wind adjustment factor (fuel-bed depth + canopy sheltering).
 *    See {@link WindReference}.
 *  - Slope is rise/run from the elevation grid, **clamped ≥ 0** — Rothermel's
 *    slope factor is upslope-only (it squares `tan φ`).
 */
export class RothermelFireModel implements IFireModel {
  readonly name = 'fire:rothermel';
  private next: Uint8Array | null = null;
  private progress: Float32Array | null = null;
  // Front-candidate scratch (see `collectCandidates`): reused per tick.
  private ignited: Uint8Array | null = null;
  private dilatedRow: Uint8Array | null = null;
  private candidate: Uint8Array | null = null;
  /** Indices of this tick's candidates, in index order, and how many. */
  private candList: Int32Array | null = null;
  private candCount = 0;
  // Flame residence time depends only on the fuel's dead bed SAV, so it is the
  // same for every cell of a given fuel id. Cache it per id instead of rebuilding
  // a fuel bed (an allocation) for every burning cell every tick.
  private readonly residenceSecById = new Map<number, number>();
  // Prepared-bed caches. A surface bed is a pure function of (fuel id, dead
  // moisture byte, scenario live moisture); the FM10 crown proxy of the moisture
  // byte alone; the WAF of (fuel id, canopy byte). The fire model used to rebuild
  // all three for every front cell every tick — profiled as most of its cost on a
  // large front — yet a 256-byte moisture axis gives at most 256 distinct beds per
  // fuel. Filled lazily, never mutated (BedIntermediates are read-only to callers),
  // so results are byte-identical to the uncached path.
  private readonly bedCache = new Map<number, BedIntermediates>();
  private readonly crownBedCache: Array<BedIntermediates | null | undefined> = new Array(256);
  private readonly wafCache = new Map<number, number>();

  private readonly liveMoisture: number;
  private readonly windReference: WindReference;
  private readonly canopy: CanopyStand;
  private readonly crownEnabled: boolean;
  private readonly elliptical: boolean;

  // Scratch records reused across cells/directions — the hot loop allocates only
  // the fuel beds it must (one surface bed per candidate cell, one FM10 bed per
  // crown candidate), never per direction.
  private readonly crownIn: CrownInputs = {
    surfaceIntensity: 0,
    surfaceRos: 0,
    fm10Ros: 0,
    cbd: 0,
    baseHeightM: 0,
    standHeightM: 0,
    foliarMoisturePct: 0,
  };
  private readonly crownOut: CrownResult = { type: CrownFire.None, cfb: 0, ros: 0, intensity: 0 };
  private readonly spread: SpreadResult = {
    rateOfSpread: 0,
    rateOfSpreadNoWindSlope: 0,
    reactionIntensity: 0,
    firelineIntensity: 0,
    flameLength: 0,
  };
  // Elliptical path only: the wind–slope resultants (surface + FM10 crown proxy)
  // and the derived per-cell geometry, all reused across cells.
  private readonly resultant: WindSlopeResultant = { headRate: 0, headUx: 1, headUy: 0, phiEffective: 0 };
  private readonly crownResultant: WindSlopeResultant = { headRate: 0, headUx: 1, headUy: 0, phiEffective: 0 };
  private readonly cell = {
    /** Surface head rate [ft/min] and the unit vector it points along. */
    headRate: 0,
    headUx: 1,
    headUy: 0,
    /** Eccentricity of the surface spread ellipse (0 = circle). */
    ecc: 0,
    /** Reaction intensity and residence time τ of this cell's bed — Byram per direction. */
    reaction: 0,
    tau: 0,
    /** FM10 crown-proxy head rate [ft/min] and its own eccentricity; see `ensureCrownHead`. */
    fm10Head: 0,
    crownEcc: 0,
    hasCrown: false,
    crownReady: false,
    cbd: 0,
    // Inputs the crown proxy needs if it turns out to be wanted.
    fm10: null as BedIntermediates | null,
    openMps: 0,
    tanSlope: 0,
    windUx: 0,
    windUy: 0,
    slopeUx: 0,
    slopeUy: 0,
  };

  constructor(
    private readonly fuel: IFuelModel,
    opts: RothermelFireModelOptions | number = {},
  ) {
    const o: RothermelFireModelOptions = typeof opts === 'number' ? { liveMoisture: opts } : opts;
    this.liveMoisture = o.liveMoisture ?? DEFAULT_LIVE_MOISTURE;
    this.windReference = o.windReference ?? 'midflame';
    this.canopy = o.canopy ?? DEFAULT_CANOPY_STAND;
    this.crownEnabled = o.crownFire ?? true;
    this.elliptical = (o.spreadShape ?? 'elliptical') === 'elliptical';
    this.crownIn.baseHeightM = this.canopy.baseHeightM;
    this.crownIn.standHeightM = this.canopy.standHeightM;
    this.crownIn.foliarMoisturePct = this.canopy.foliarMoisturePct;
  }

  /**
   * Fire behaviour along one direction into a cell: surface Rothermel, then the
   * crown transition when the cell has a crown and the surface fire is hot enough.
   * `windMps` is the midflame wind along the direction (≥ 0, already WAF-reduced);
   * `openWindMps` the corresponding 20-ft wind for the crown proxy. Returns the
   * rate in m/s and leaves intensity [kW/m] + crown type in `this.crownOut`.
   */
  private directionBehaviour(
    bed: BedIntermediates,
    fm10: BedIntermediates | null,
    cbd: number,
    windMps: number,
    openWindMps: number,
    tanSlope: number,
  ): number {
    const r = spreadFromIntermediates(bed, { midflameWind: metersPerSecToFtPerMin(windMps), tanSlope }, this.spread);
    const out = this.crownOut;
    out.type = CrownFire.None;
    out.intensity = btuPerFtSecToKwPerM(r.firelineIntensity);
    if (fm10 === null || r.rateOfSpread <= 0) return ftPerMinToMetersPerSec(r.rateOfSpread);

    const inp = this.crownIn;
    inp.surfaceIntensity = out.intensity;
    inp.surfaceRos = r.rateOfSpread * 0.3048; // ft/min → m/min
    inp.cbd = cbd;
    // Cheap reject before the FM10 evaluation: below I_0 nothing changes.
    inp.fm10Ros = 0;
    if (evaluateCrownFire(inp, out).type === CrownFire.None) {
      return ftPerMinToMetersPerSec(r.rateOfSpread);
    }
    const crownWind = metersPerSecToFtPerMin(CROWN_WIND_REDUCTION * openWindMps);
    inp.fm10Ros = spreadFromIntermediates(fm10, { midflameWind: crownWind, tanSlope }, this.spread).rateOfSpread * 0.3048;
    evaluateCrownFire(inp, out);
    return out.ros / 60; // m/min → m/s
  }

  /**
   * Elliptical path: everything about a cell that does not depend on which ray
   * the fire arrives along — the wind–slope resultant, the head rate and its
   * direction, and the eccentricity of the spread ellipse (plus the FM10 crown
   * proxy's own head rate and ellipse). Filled once per candidate cell into
   * {@link cell}; {@link ellipticalDirection} then costs one cosine per ray.
   *
   * `windMag` is the raw world wind magnitude [m/s] at this cell; `waf` reduces
   * it to flame height. `tanSlope` is the magnitude of the elevation gradient and
   * `slopeUx/slopeUy` its uphill unit vector.
   */
  private prepareCellEllipse(
    bed: BedIntermediates,
    fm10: BedIntermediates | null,
    cbd: number,
    rf: RothermelFuel,
    windMag: number,
    windUx: number,
    windUy: number,
    waf: number,
    tanSlope: number,
    slopeUx: number,
    slopeUy: number,
  ): void {
    const c = this.cell;
    c.reaction = bed.reactionIntensity;
    // τ = 384/σ depends only on the bed, so it is hoisted out of the ray loop —
    // the arithmetic below still associates exactly as `firelineIntensity` does.
    c.tau = flameResidenceTime(bed.sigma);
    c.cbd = cbd;

    const phiW = windFactorFrom(bed, metersPerSecToFtPerMin(windMag * waf));
    const phiS = bed.slopeK * tanSlope * tanSlope;
    const res = windSlopeResultant(
      bed.rateOfSpreadNoWindSlope, phiW, windUx, windUy, phiS, slopeUx, slopeUy, this.resultant,
    );
    c.headRate = res.headRate;
    c.headUx = res.headUx;
    c.headUy = res.headUy;
    c.ecc = eccentricity(lengthToBreadthRatio(effectiveWindSpeed(bed, res.phiEffective) * FT_PER_MIN_TO_MPH));

    // The FM10 crown proxy is only needed once a direction actually clears Van
    // Wagner's I₀ — which most cells never do. Stash its inputs and defer;
    // `ensureCrownHead` fills it in at most once per cell.
    c.hasCrown = fm10 !== null;
    c.crownReady = false;
    c.fm10Head = 0;
    c.crownEcc = 0;
    c.fm10 = fm10;
    c.openMps = fm10 !== null ? this.openWind(rf, windMag, waf) : 0;
    c.tanSlope = tanSlope;
    c.windUx = windUx;
    c.windUy = windUy;
    c.slopeUx = slopeUx;
    c.slopeUy = slopeUy;
  }

  /**
   * Fill in the FM10 crown-proxy head rate and its (rounder) crown ellipse for
   * the current cell, once. The proxy runs on 0.4 × the 20-ft wind (Rothermel
   * 1991) about the same wind–slope resultant direction as the surface fire.
   */
  private ensureCrownHead(): void {
    const c = this.cell;
    if (c.crownReady) return;
    c.crownReady = true;
    const fm10 = c.fm10!;
    const cRes = windSlopeResultant(
      fm10.rateOfSpreadNoWindSlope,
      windFactorFrom(fm10, metersPerSecToFtPerMin(CROWN_WIND_REDUCTION * c.openMps)),
      c.windUx,
      c.windUy,
      fm10.slopeK * c.tanSlope * c.tanSlope,
      c.slopeUx,
      c.slopeUy,
      this.crownResultant,
    );
    c.fm10Head = cRes.headRate;
    c.crownEcc = eccentricity(crownLengthToBreadthRatio(metersPerSecToFtPerMin(c.openMps) * FT_PER_MIN_TO_MPH));
  }

  /**
   * Elliptical path: fire behaviour along one ray, given `cosTheta` between that
   * ray and the cell's head direction. Returns the rate in m/s and leaves
   * intensity [kW/m] + crown type in `this.crownOut`, exactly like
   * {@link directionBehaviour}. Costs no fuel-bed work — the ellipse is a scalar.
   */
  private ellipticalDirection(cosTheta: number): number {
    const c = this.cell;
    const out = this.crownOut;
    const surfFtMin = ellipticalRate(c.headRate, c.ecc, cosTheta);
    out.type = CrownFire.None;
    // Byram, with τ hoisted to the cell — same association as `firelineIntensity`.
    out.intensity = btuPerFtSecToKwPerM((c.reaction * (surfFtMin * c.tau)) / 60);
    if (!c.hasCrown || surfFtMin <= 0) return ftPerMinToMetersPerSec(surfFtMin);

    const inp = this.crownIn;
    inp.surfaceIntensity = out.intensity;
    inp.surfaceRos = surfFtMin * 0.3048; // ft/min → m/min
    inp.cbd = c.cbd;
    // Cheap reject before the crown rate is read off its own ellipse.
    inp.fm10Ros = 0;
    if (evaluateCrownFire(inp, out).type === CrownFire.None) return ftPerMinToMetersPerSec(surfFtMin);
    this.ensureCrownHead();
    inp.fm10Ros = ellipticalRate(c.fm10Head, c.crownEcc, cosTheta) * 0.3048;
    evaluateCrownFire(inp, out);
    return out.ros / 60; // m/min → m/s
  }

  /** The prepared surface bed for a fuel at a dead-moisture byte (cached; see `bedCache`). */
  private surfaceBedFor(fuelId: number, rf: RothermelFuel, moistureByte: number): BedIntermediates {
    const key = fuelId * 256 + moistureByte;
    let bed = this.bedCache.get(key);
    if (bed === undefined) {
      bed = prepareFuelBed(fuelBed(rf, byteToFraction(moistureByte), this.liveMoisture));
      this.bedCache.set(key, bed);
    }
    return bed;
  }

  /** The FM10 crown-proxy bed for a cell, or null when the cell cannot crown. */
  private crownBedFor(canopyByte: number, moistureByte: number): BedIntermediates | null {
    if (!this.crownEnabled) return null;
    if (canopyBulkDensity(canopyByte, this.canopy) < MIN_CROWN_CBD) return null;
    let bed = this.crownBedCache[moistureByte];
    if (bed === undefined) {
      bed = prepareFuelBed(fuelBed(FM10, byteToFraction(moistureByte), this.liveMoisture));
      this.crownBedCache[moistureByte] = bed;
    }
    return bed;
  }

  /**
   * Factor that turns this cell's world wind into midflame wind: 1 under the
   * `'midflame'` convention, else the Albini–Baughman WAF for the cell's fuel-bed
   * depth and the canopy over it (cached per fuel id × canopy byte).
   */
  private midflameFactor(fuelId: number, rf: RothermelFuel, canopyByte: number): number {
    if (this.windReference === 'midflame') return 1;
    const key = fuelId * 256 + canopyByte;
    let waf = this.wafCache.get(key);
    if (waf === undefined) {
      waf = windAdjustmentFactor(
        rf.depth,
        canopyCoverFraction(canopyByte),
        this.canopy.standHeightM,
        this.canopy.crownRatio,
      );
      this.wafCache.set(key, waf);
    }
    return waf;
  }

  /**
   * The 20-ft open wind for the crown proxy, from a world wind component `w` and
   * the cell's WAF: the layer itself under `'open'`; under `'midflame'` the layer
   * is flame-height wind, so back the open wind out through the surface fuel's
   * unsheltered WAF (the reduction a 20-ft wind would have suffered over that bed).
   */
  private openWind(rf: RothermelFuel, w: number, waf: number): number {
    if (this.windReference === 'open') return w;
    const u = unshelteredWaf(rf.depth);
    return u > 0 ? (w * waf) / u : 0;
  }

  /**
   * Elliptical path: the cell's own terrain slope, by central differences on
   * `elevation` (clamped to a one-sided difference at the map edge). Leaves the
   * magnitude as rise/run in `grad.tan` and the **uphill** unit vector in
   * `grad.ux/uy`, which is what the wind–slope vector sum wants.
   *
   * The per-ray law instead took the rise from the ignited neighbour to this
   * cell. Both are defensible discretizations; the ellipse needs a single slope
   * *vector* per site, and Rothermel's φ_s is a property of the site, so the
   * gradient is the more faithful of the two (plan §"Design decisions").
   */
  private readonly grad = { tan: 0, ux: 0, uy: 0 };
  private cellGradient(
    elev: Float32Array, i: number, x: number, y: number, width: number, height: number, cellSize: number,
  ): void {
    const xm = x > 0 ? i - 1 : i;
    const xp = x < width - 1 ? i + 1 : i;
    const ym = y > 0 ? i - width : i;
    const yp = y < height - 1 ? i + width : i;
    const spanX = xp - xm; // 2 inside the map, 1 against an edge, 0 if width === 1
    const spanY = (yp - ym) / width;
    const dzx = spanX > 0 ? (elev[xp] - elev[xm]) / (spanX * cellSize) : 0;
    const dzy = spanY > 0 ? (elev[yp] - elev[ym]) / (spanY * cellSize) : 0;
    const mag = Math.sqrt(dzx * dzx + dzy * dzy);
    const g = this.grad;
    g.tan = mag;
    g.ux = mag > 0 ? dzx / mag : 0;
    g.uy = mag > 0 ? dzy / mag : 0;
  }

  /**
   * Collect the cells the tick has to look at, into {@link candList} in index
   * order: every cell with an ignited 8-neighbour (the only ones the front can
   * reach) that is not already Burned. The neighbourhood test is a separable 3×3
   * dilation of the ignited mask — one horizontal pass, one vertical pass, both
   * tight typed-array loops — and the compaction rides along on the vertical
   * pass, so the sweep itself becomes O(front) instead of a scan of the map with
   * two rejections per cell. (An 8-neighbour read for every unburned burnable
   * cell every tick profiled at ~10× the cost of the actual spread arithmetic;
   * this is the cheaper shape of that same test.)
   *
   * Pure function of the pre-tick `fire` buffer, and the sweep is
   * order-independent (each cell writes only its own `progress`/`next`), so
   * results are byte-identical to scanning the whole map.
   */
  private collectCandidates(fire: Uint8Array, width: number, height: number): void {
    const n = fire.length;
    if (this.ignited === null || this.ignited.length !== n) {
      this.ignited = new Uint8Array(n);
      this.dilatedRow = new Uint8Array(n);
      this.candidate = new Uint8Array(n);
      this.candList = new Int32Array(n);
    }
    const ign = this.ignited;
    const row = this.dilatedRow!;
    const cand = this.candidate!;
    const list = this.candList!;
    let count = 0;
    // Unburned is 0, so "ever ignited" is simply fire[i] !== 0.
    for (let i = 0; i < n; i++) ign[i] = fire[i] !== 0 ? 1 : 0;
    // Horizontal: row[i] = ign[i-1] | ign[i] | ign[i+1] within the row.
    for (let y = 0; y < height; y++) {
      const r0 = y * width;
      const r1 = r0 + width - 1;
      if (width === 1) {
        row[r0] = ign[r0];
        continue;
      }
      row[r0] = ign[r0] | ign[r0 + 1];
      for (let i = r0 + 1; i < r1; i++) row[i] = ign[i - 1] | ign[i] | ign[i + 1];
      row[r1] = ign[r1 - 1] | ign[r1];
    }
    // Vertical: cand[i] = row[i-w] | row[i] | row[i+w], compacting as it goes.
    if (height === 1) {
      for (let i = 0; i < n; i++) {
        cand[i] = row[i];
        if (row[i] !== 0 && fire[i] !== FireState.Burned) list[count++] = i;
      }
      this.candCount = count;
      return;
    }
    for (let i = 0; i < width; i++) {
      const c = row[i] | row[i + width];
      cand[i] = c;
      if (c !== 0 && fire[i] !== FireState.Burned) list[count++] = i;
    }
    for (let i = width; i < n - width; i++) {
      const c = row[i - width] | row[i] | row[i + width];
      cand[i] = c;
      if (c !== 0 && fire[i] !== FireState.Burned) list[count++] = i;
    }
    for (let i = n - width; i < n; i++) {
      const c = row[i - width] | row[i];
      cand[i] = c;
      if (c !== 0 && fire[i] !== FireState.Burned) list[count++] = i;
    }
    this.candCount = count;
  }

  step(world: WorldState, dt: number): void {
    const { width, height, cellSize, layers } = world;
    const fire = layers.fire.data;
    const fuelL = layers.fuel.data;
    const elev = layers.elevation.data;
    const moist = layers.moisture.data;
    const windU = layers.windU.data;
    const windV = layers.windV.data;
    const canopyL = layers.canopy.data;
    const burnElapsed = layers.burnElapsed.data;
    const intensity = layers.intensity.data;
    const crown = layers.crown.data;

    if (this.next === null || this.next.length !== fire.length) {
      this.next = new Uint8Array(fire.length);
      this.progress = new Float32Array(fire.length);
    }
    const next = this.next;
    const progress = this.progress!;
    next.set(fire);
    // Only the front (and the cells it can reach) can change this tick; everything
    // else is rejected once, in the compaction, not in the sweep.
    this.collectCandidates(fire, width, height);
    const candList = this.candList!;
    const candCount = this.candCount;

    for (let k = 0; k < candCount; k++) {
      const i = candList[k];
      const x = i % width;
      const y = (i / width) | 0;
      const state = fire[i];

      const fp = this.fuel.getParams(fuelL[i]);
      const rf = fp.rothermel;

      if (state === FireState.Burning) {
        // An externally-lit cell (tool / ember / backburn) has no arriving front
        // and hence no recorded intensity: give it its own head-fire intensity
        // once, so every burning cell carries a defined value for readers.
        if (intensity[i] === 0 && rf) {
          const bed = this.surfaceBedFor(fuelL[i], rf, moist[i]);
          const waf = this.midflameFactor(fuelL[i], rf, canopyL[i]);
          const speed = Math.hypot(windU[i], windV[i]);
          const fm10 = this.crownBedFor(canopyL[i], moist[i]);
          const cbd = canopyBulkDensity(canopyL[i], this.canopy);
          if (this.elliptical) {
            // The head of its own ellipse: full wind, the cell's own slope.
            this.cellGradient(elev, i, x, y, width, height, cellSize);
            const wm = speed;
            this.prepareCellEllipse(
              bed, fm10, cbd, rf, wm,
              wm > 0 ? windU[i] / wm : 0,
              wm > 0 ? windV[i] / wm : 0,
              waf, this.grad.tan, this.grad.ux, this.grad.uy,
            );
            this.ellipticalDirection(1);
          } else {
            this.directionBehaviour(bed, fm10, cbd, speed * waf, this.openWind(rf, speed, waf), 0);
          }
          intensity[i] = this.crownOut.intensity;
          crown[i] = this.crownOut.type;
        }
        // Burnout is cosmetic flame duration (Albini residence time τ = 384/σ),
        // independent of spread. No rothermel descriptor ⇒ can't sustain ⇒ out.
        burnElapsed[i] += dt;
        let residenceSec = this.residenceSecById.get(fuelL[i]);
        if (residenceSec === undefined) {
          residenceSec = rf ? flameResidenceTime(bedSAV(rf)) * 60 : 0;
          this.residenceSecById.set(fuelL[i], residenceSec);
        }
        if (burnElapsed[i] >= residenceSec) next[i] = FireState.Burned;
        continue;
      }

      // Unburned with an ignited neighbour: accumulate the fastest arriving front.
      if (!fp.burnable || !rf) continue;

      // The expensive bed assembly happens at most ONCE per (fuel, moisture byte)
      // — cached — and the eight directions below only evaluate the cheap
      // wind/slope factors against it.
      const bed = this.surfaceBedFor(fuelL[i], rf, moist[i]);
      // Wind sampled at THIS (destination) cell — see world.ts windU/windV — and
      // reduced to midflame here, once, since the factor is a property of the cell.
      const waf = this.midflameFactor(fuelL[i], rf, canopyL[i]);
      const wu = windU[i];
      const wv = windV[i];
      const fm10 = this.crownBedFor(canopyL[i], moist[i]);
      const cbd = canopyBulkDensity(canopyL[i], this.canopy);

      // Elliptical path: one Rothermel evaluation for the whole cell, up front.
      // Every ray below is then a cosine against the head direction.
      if (this.elliptical) {
        this.cellGradient(elev, i, x, y, width, height, cellSize);
        const wm = Math.sqrt(wu * wu + wv * wv);
        this.prepareCellEllipse(
          bed, fm10, cbd, rf, wm,
          wm > 0 ? wu / wm : 0,
          wm > 0 ? wv / wm : 0,
          waf, this.grad.tan, this.grad.ux, this.grad.uy,
        );
      }

      let maxRate = 0; // max ROS_dir / (dist·cellSize)  [1/s]
      let bestIntensity = 0; // fire behaviour along that fastest direction
      let bestCrown = 0;
      for (let n = 0; n < 8; n++) {
        const nx = x + NX[n];
        const ny = y + NY[n];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!isIgnited(fire[ni])) continue;

        const dist = NDIST[n];
        // Spread direction = from the ignited neighbour toward this cell.
        const dx = -NX[n] / dist;
        const dy = -NY[n] / dist;
        const run = dist * cellSize;

        let rosMps: number;
        if (this.elliptical) {
          const c = this.cell;
          rosMps = this.ellipticalDirection(dx * c.headUx + dy * c.headUy);
        } else {
          // Wind (m/s) projected onto the spread direction, downwind only.
          const windAlong = dx * wu + dy * wv;
          const along = windAlong > 0 ? windAlong : 0;

          // Slope rise/run from neighbour to this cell; upslope only.
          const rise = elev[i] - elev[ni];
          const tanSlope = rise > 0 ? rise / run : 0;

          rosMps = this.directionBehaviour(
            bed,
            fm10,
            cbd,
            along * waf,
            this.openWind(rf, along, waf),
            tanSlope,
          );
        }
        const rate = rosMps / run;
        if (rate > maxRate) {
          maxRate = rate;
          bestIntensity = this.crownOut.intensity;
          bestCrown = this.crownOut.type;
        }
      }

      progress[i] += maxRate * dt;
      if (progress[i] >= 1) {
        next[i] = FireState.Burning;
        burnElapsed[i] = 0;
        intensity[i] = bestIntensity;
        crown[i] = bestCrown;
      }
    }

    fire.set(next);
  }
}

/** A cell is a spread source once it has ever ignited (Burning or Burned). */
function isIgnited(state: number): boolean {
  return state === FireState.Burning || state === FireState.Burned;
}

/**
 * Characteristic SAV σ of a fuel's dead bed — drives the residence time. Moisture
 * is irrelevant to σ, so the bed is assembled at 0 just to reuse {@link deadFuelBed}.
 */
function bedSAV(rf: RothermelFuel): number {
  return characteristicSAV(deadFuelBed(rf, 0).particles);
}
