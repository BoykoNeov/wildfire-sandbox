import type { IFuelModel, RothermelFuel } from '../models/IFuelModel';
import { byteToFraction } from '../core/moisture';
import { ANDERSON_13, deadFuelBed, fuelBed, herbLoadTransferFraction, type BedOptions } from './anderson13';
import {
  canopyBulkDensity,
  canopyCoverFraction,
  DEFAULT_CANOPY_STAND,
  type CanopyStand,
} from './canopyStand';
import { liveMoistureFromGreenness } from './moistureScenarios';
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
import { ellipseDimensions, richardsVelocity, type EllipseDimensions, type MarkerVelocity } from './richards';

/**
 * Everything a fire model needs to know about **one cell** — the fuel bed, the
 * wind reduction, the wind–slope resultant and the ellipse it implies, the
 * crown-fire transition, the Byram intensity — with no opinion whatever about
 * how the front is *carried*.
 *
 * Extracted from {@link RothermelFireModel} in Phase 11 Stage 0
 * (`docs/plans/phase-11-smooth-wavefront.md` §D2) so the raster front and the
 * marker front can share it instead of drifting apart. The extraction is a pure
 * move: every arithmetic expression below is character-for-character what the
 * raster model ran before, in the same order, and the `timber-crown-run` golden
 * is the gate on that.
 *
 * **It is a two-phase stateful object, not a pure function**, and deliberately:
 *
 *  - {@link prepareCellEllipse} does the per-*cell* work once — the Rothermel
 *    evaluation, the resultant, the eccentricity — into {@link cell};
 *  - {@link ellipticalDirection} then costs one cosine per *direction*, and
 *    leaves the direction's intensity and crown type in {@link crownOut}.
 *
 * The split is not stylistic. Intensity and crown type are per-direction (the
 * Byram intensity reads the direction's own rate off the ellipse, and Van
 * Wagner's I₀ test reads that intensity), while the bed and the resultant are
 * per-cell; and the FM10 crown proxy is *deferred* to the first direction that
 * actually clears I₀, which most cells never do. A record-returning pure
 * function would have to either evaluate the crown eagerly (a behaviour change)
 * or allocate per direction (the hot loop allocates nothing per direction, and
 * the architecture invariants forbid per-cell virtual calls).
 *
 * A marker front reaches exactly the same two phases: a marker's displacement
 * `d` gives `cosTheta = (d·headU)/|d|` for {@link ellipticalDirection}, so the
 * flank of a Huygens fire is cooler than its head for free, with no new maths.
 */

/**
 * What the world's `windU/windV` field means to a model.
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
 * The convention a model assumes when a scenario says nothing. Exported so
 * `loadScenario` can hand the *same* default to the spotting system, which needs
 * the 20-ft wind for Albini's spotting distance and must never disagree with the
 * fire model about what the wind layer is.
 */
export const DEFAULT_WIND_REFERENCE: WindReference = 'midflame';

/** Default live-fuel moisture [fraction] — 100%, a green-but-not-peak baseline. */
const DEFAULT_LIVE_MOISTURE = 1.0;
/** Rothermel-1991's crown proxy fuel bed: Anderson FM10. */
const FM10 = ANDERSON_13.get(10)!;

/**
 * The knobs that describe **the fuel and the site**, and so belong to every fire
 * model that runs Rothermel — as against the knobs that describe how the front
 * is discretised (`spreadShape`, `spreadTemplate`), which are raster-only and
 * live on {@link RothermelFireModelOptions}.
 */
export interface SurfaceBehaviourOptions {
  /**
   * Live-fuel moisture [fraction] applied to every live particle when the bed is
   * assembled (the world moisture layer is dead-only — plan §D6). A scenario-level
   * scalar; 1.0 = 100%, a defensible "green live fuel" default that lets the
   * live-bearing shrub models carry. A single value for both live herb and woody.
   */
  liveMoisture?: number;
  /**
   * 10-hr dead-fuel moisture [fraction] for every cell. Omit and the 10-hr class
   * takes the cell's own fine (1-hr) moisture byte, exactly as before.
   *
   * This is a **scenario-level constant, not a layer**, and deliberately so: the
   * 10-hr timelag is longer than a whole sandbox run, so the coarse classes barely
   * move while the fire burns — what matters is the antecedent condition the run
   * starts in, which is what BehavePlus asks for too (`moistureScenarios.cpp`
   * ships four dead triples: 3/4/5, 6/7/8, 9/10/11, 12/13/14 %). The honest cost
   * is that coarse dead moisture is spatially **uniform** while the fine layer
   * keeps its wet-valley / dry-ridge pattern; with map-uniform weather drivers the
   * fine layer is the only spatial information the sim actually has.
   */
  dead10hMoisture?: number;
  /** 100-hr dead-fuel moisture [fraction]. See {@link dead10hMoisture}. */
  dead100hMoisture?: number;
  /**
   * Season as one knob: `0` = fully cured (late season, everything brown), `1` =
   * fully green (spring flush). Sets the two live classes apart along the standard
   * BehavePlus ladder — herbaceous 30…120%, woody 60…150%
   * (`liveMoistureFromGreenness`). Prefer this to {@link liveMoisture}, which
   * applies one number to both classes.
   *
   * Moisture only on its own. Curing's *other* half — moving cured herbaceous
   * load into the dead fuel — is {@link dynamicHerbLoad}, which is off by
   * default; that is why this knob is named for the season and not `curing`.
   * Overridden per class by {@link liveHerbMoisture} / {@link liveWoodyMoisture};
   * falls back to {@link liveMoisture} when omitted.
   */
  greenness?: number;
  /** Live herbaceous moisture [fraction]; overrides {@link greenness}. */
  liveHerbMoisture?: number;
  /** Live woody moisture [fraction]; overrides {@link greenness}. */
  liveWoodyMoisture?: number;
  /**
   * Whether to cure part of the live herbaceous load into the dead fuel — the
   * fraction taken from the live herbaceous moisture in use
   * (`herbLoadTransferFraction`, BehavePlus `dynamicLoadTransfer`). **Three
   * states**, and omitted is not the same as `false`:
   *
   * | value | meaning |
   * |---|---|
   * | omitted (default) | follow each fuel model's own `dynamic` flag — what BehavePlus does |
   * | `true` | force it on for every model, dynamic or not |
   * | `false` | force it off, even for a dynamic model |
   *
   * The default leaves every Anderson bed byte-identical, because all thirteen
   * standard models are static — so no existing scenario moves. In the Scott &
   * Burgan 40 the flag is set on 17 models (all nine grass, all four grass-shrub,
   * SH1, SH9, TU1, TU3) and those cure by default, which is the point of that
   * catalogue. `true` is the Phase-9b extension: curing an Anderson model that
   * the catalogue itself declares static. `false` isolates the moisture half of
   * a season from the load half.
   *
   * It pairs with {@link greenness}: one season knob drives both halves, because
   * the transfer reads the moisture the season set.
   *
   * **Forcing it on FM2 makes it burn *less*, which is not the intuition.** The
   * transferred class arrives at the live-herb SAV (1500 for FM2, against its
   * fine 3000), so it is not fine 1-hr litter, and moving it changes no geometry
   * at all: same total load, same depth, same packing ratio, same characteristic
   * SAV. All that changes is which moisture of extinction damps it, and FM2's
   * dead M_x is 15 % against a live M_x near 1044 %. R₀ ×0.957, fireline
   * intensity ×0.841 at full cure. The grass models of the dynamic catalogue,
   * whose load is mostly live herbaceous, go the other way — see
   * `docs/science.md` §3c.
   */
  dynamicHerbLoad?: boolean;
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
}

/**
 * The per-cell record {@link SurfaceBehaviour.prepareCellEllipse} fills and
 * {@link SurfaceBehaviour.ellipticalDirection} reads. Declared as one shape so
 * V8 keeps a single hidden class for it across every cell of a run.
 */
export interface CellEllipse {
  /** Surface head rate [ft/min] and the unit vector it points along. */
  headRate: number;
  headUx: number;
  headUy: number;
  /** Eccentricity of the surface spread ellipse (0 = circle). */
  ecc: number;
  /** Reaction intensity and residence time τ of this cell's bed — Byram per direction. */
  reaction: number;
  tau: number;
  /** FM10 crown-proxy head rate [ft/min] and its own eccentricity; see `ensureCrownHead`. */
  fm10Head: number;
  crownEcc: number;
  hasCrown: boolean;
  crownReady: boolean;
  cbd: number;
  // Inputs the crown proxy needs if it turns out to be wanted.
  fm10: BedIntermediates | null;
  openMps: number;
  tanSlope: number;
  windUx: number;
  windUy: number;
  slopeUx: number;
  slopeUy: number;
}

/** The terrain gradient {@link SurfaceBehaviour.cellGradient} leaves behind. */
export interface CellGradient {
  /** Magnitude, as rise/run. */
  tan: number;
  /** Uphill unit vector. */
  ux: number;
  uy: number;
}

export class SurfaceBehaviour {
  // Flame residence time depends only on the fuel's dead bed SAV, so it is the
  // same for every cell of a given fuel id. Cache it per id instead of rebuilding
  // a fuel bed (an allocation) for every burning cell every tick.
  // NOTE: `bedOptions` also feeds that bed (a cured herbaceous load transfer
  // coarsens it), and those options are construction-time constants — which is
  // the only reason a key of fuel id alone is still sound. Making the transfer or
  // the coarse moistures *dynamic* would invalidate this cache and `bedCache`
  // together.
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
  /**
   * The two bed-option records a fuel can get: without the cured-herbaceous load
   * transfer and with it. `staticBedOptions` is `undefined` when the scenario
   * asked for no per-class splits either (then every class falls back to the
   * positional moisture, nothing is transferred, and beds are byte-identical to
   * the pre-split model). Both are built once at construction and reused for
   * every bed, so {@link bedOptionsFor} costs a branch rather than an allocation
   * and the bed cache key stays (fuel id, fine moisture byte).
   */
  private readonly staticBedOptions: BedOptions | undefined;
  private readonly curedBedOptions: BedOptions;
  /**
   * `true`/`false` force the transfer on/off for every model; `undefined` follows
   * each fuel's own `dynamic` flag. See {@link SurfaceBehaviourOptions.dynamicHerbLoad}.
   */
  private readonly forceHerbLoad: boolean | undefined;
  private readonly windReference: WindReference;
  readonly canopy: CanopyStand;
  private readonly crownEnabled: boolean;

  /**
   * `burnable` per fuel id, filled lazily (−1 = not yet asked). Both fronts need
   * burnability in a hot loop — the raster's knight-move supercover gate twice
   * per long ray, the marker front's barrier guard once per marker per substep —
   * and going through `IFuelModel.getParams` there would be a per-cell virtual
   * call, which the architecture invariants forbid. A fuel *id*'s burnability
   * never changes — suppression rewrites the id at a cell, not the meaning of the
   * id — so this is the same caching argument as `bedCache` and `residenceSecById`.
   */
  private readonly burnableById = new Int8Array(256).fill(-1);

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
  /** Where {@link ellipticalDirection} / {@link directionBehaviour} leave intensity + crown type. */
  readonly crownOut: CrownResult = { type: CrownFire.None, cfb: 0, ros: 0, intensity: 0 };
  private readonly spread: SpreadResult = {
    rateOfSpread: 0,
    rateOfSpreadNoWindSlope: 0,
    reactionIntensity: 0,
    firelineIntensity: 0,
    flameLength: 0,
  };
  // The wind–slope resultants (surface + FM10 crown proxy) and the derived
  // per-cell geometry, all reused across cells.
  private readonly resultant: WindSlopeResultant = { headRate: 0, headUx: 1, headUy: 0, phiEffective: 0 };
  private readonly crownResultant: WindSlopeResultant = { headRate: 0, headUx: 1, headUy: 0, phiEffective: 0 };
  readonly cell: CellEllipse = {
    headRate: 0,
    headUx: 1,
    headUy: 0,
    ecc: 0,
    reaction: 0,
    tau: 0,
    fm10Head: 0,
    crownEcc: 0,
    hasCrown: false,
    crownReady: false,
    cbd: 0,
    fm10: null,
    openMps: 0,
    tanSlope: 0,
    windUx: 0,
    windUy: 0,
    slopeUx: 0,
    slopeUy: 0,
  };
  readonly grad: CellGradient = { tan: 0, ux: 0, uy: 0 };
  // Marker path only: the FM10 crown proxy's own ellipse and the velocity read
  // off it, so the crown rate reaches `evaluateCrownFire` in the same
  // (normal-form) terms as the surface rate beside it. See {@link markerBehaviour}.
  private readonly crownDim: EllipseDimensions = { a: 0, b: 0, c: 0 };
  private readonly crownVel: MarkerVelocity = { vx: 0, vy: 0 };

  constructor(
    private readonly fuel: IFuelModel,
    o: SurfaceBehaviourOptions = {},
  ) {
    this.liveMoisture = o.liveMoisture ?? DEFAULT_LIVE_MOISTURE;
    // Resolve the per-class splits once. Precedence is explicit per class, then
    // the greenness curve, then the single `liveMoisture` fallback inside the bed
    // builder. When nothing asks for a split the whole record stays `undefined`
    // and the assembled beds are byte-identical to the pre-split model.
    const green = o.greenness !== undefined ? liveMoistureFromGreenness(o.greenness) : undefined;
    const liveHerb = o.liveHerbMoisture ?? green?.liveHerb;
    const liveWoody = o.liveWoodyMoisture ?? green?.liveWoody;
    // The transfer reads the live herbaceous moisture that will actually reach
    // the bed — the explicit override, else the greenness curve, else the single
    // `liveMoisture` fallback — not `greenness` itself. BehavePlus reads
    // `moistureLive_[0]`, the value in use, and a scenario is allowed to set
    // `liveHerbMoisture` with no greenness at all.
    const herbLoadTransfer = herbLoadTransferFraction(liveHerb ?? this.liveMoisture);
    this.forceHerbLoad = o.dynamicHerbLoad;
    const splits =
      o.dead10hMoisture !== undefined ||
      o.dead100hMoisture !== undefined ||
      liveHerb !== undefined ||
      liveWoody !== undefined;
    const base = { dead10h: o.dead10hMoisture, dead100h: o.dead100hMoisture, liveHerb, liveWoody };
    this.staticBedOptions = splits ? { ...base, herbLoadTransfer: undefined } : undefined;
    this.curedBedOptions = { ...base, herbLoadTransfer };
    this.windReference = o.windReference ?? DEFAULT_WIND_REFERENCE;
    this.canopy = o.canopy ?? DEFAULT_CANOPY_STAND;
    this.crownEnabled = o.crownFire ?? true;
    this.crownIn.baseHeightM = this.canopy.baseHeightM;
    this.crownIn.standHeightM = this.canopy.standHeightM;
    this.crownIn.foliarMoisturePct = this.canopy.foliarMoisturePct;
  }

  /**
   * **The `'perDirection'` (Phase-2) path only** — the elliptical law goes
   * through {@link prepareCellEllipse} + {@link ellipticalDirection} instead.
   * Kept reachable so the two laws stay comparable; see `SpreadShape` for why it
   * is not the default. It lives here rather than on the raster model only
   * because it shares this object's bed caches and scratch records; no marker
   * front calls it.
   *
   * Fire behaviour along one direction into a cell: surface Rothermel, then the
   * crown transition when the cell has a crown and the surface fire is hot enough.
   * `windMps` is the midflame wind along the direction (≥ 0, already WAF-reduced);
   * `openWindMps` the corresponding 20-ft wind for the crown proxy. Returns the
   * rate in m/s and leaves intensity [kW/m] + crown type in {@link crownOut}.
   */
  directionBehaviour(
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
   * Phase one of two: everything about a cell that does not depend on which
   * direction the fire arrives along — the wind–slope resultant, the head rate
   * and its direction, and the eccentricity of the spread ellipse (plus the FM10
   * crown proxy's own head rate and ellipse). Filled once per cell into
   * {@link cell}; {@link ellipticalDirection} then costs one cosine per direction.
   *
   * `windMag` is the raw world wind magnitude [m/s] at this cell; `waf` reduces
   * it to flame height. `tanSlope` is the magnitude of the elevation gradient and
   * `slopeUx/slopeUy` its uphill unit vector.
   */
  prepareCellEllipse(
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
    // τ = 384/σ depends only on the bed, so it is hoisted out of the direction
    // loop — the arithmetic below still associates exactly as `firelineIntensity` does.
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
   * Phase two of two: fire behaviour along one direction, given `cosTheta`
   * between that direction and the cell's head direction. Returns the rate in
   * m/s and leaves intensity [kW/m] + crown type in {@link crownOut}, exactly
   * like {@link directionBehaviour}. Costs no fuel-bed work — the ellipse is a
   * scalar.
   */
  ellipticalDirection(cosTheta: number): number {
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

  /**
   * Phase two of two, **for a marker front**: fire behaviour at a marker whose
   * own outward speed is already known, `surfFtMin` [ft/min], with
   * `tangentX/tangentY` the local perimeter tangent that produced it. Returns the
   * rate in m/s and leaves intensity [kW/m] + crown type in {@link crownOut},
   * exactly like {@link ellipticalDirection}.
   *
   * **Why the rate comes in rather than being read off the ellipse.** A marker
   * sits *on the fire edge*, and the rate there is the one perpendicular to the
   * perimeter — Richards' velocity, which is Behave's Catchpole-et-al-1982 form.
   * {@link ellipticalDirection} instead reads the ellipse about its *focus*,
   * which is the rate of a front expanding from an ignition point. Both are in
   * `fireEllipse.ts` and its header already says which belongs where; a marker
   * front is the first caller that needs the other one.
   *
   * **Both sides of the crown test are normal-form, deliberately.** Van Wagner's
   * I₀ is compared against a surface intensity built from `surfFtMin`, and the
   * FM10 crown rate that follows is read off the crown ellipse with the *same*
   * tangent rather than off its focus — otherwise the two rates handed to
   * `evaluateCrownFire` would be taken at different points of their respective
   * ellipses, and the fire would crown in the wrong places with nothing erroring
   * (`docs/plans/phase-11-smooth-wavefront.md` §5c).
   *
   * The crown proxy stays deferred: most markers never clear I₀, and
   * {@link ensureCrownHead} still runs at most once per cell.
   */
  markerBehaviour(surfFtMin: number, tangentX: number, tangentY: number): number {
    const c = this.cell;
    const out = this.crownOut;
    out.type = CrownFire.None;
    // Byram, with tau hoisted to the cell - same association as `firelineIntensity`.
    out.intensity = btuPerFtSecToKwPerM((c.reaction * (surfFtMin * c.tau)) / 60);
    if (!c.hasCrown || surfFtMin <= 0) return ftPerMinToMetersPerSec(surfFtMin);

    const inp = this.crownIn;
    inp.surfaceIntensity = out.intensity;
    inp.surfaceRos = surfFtMin * 0.3048; // ft/min -> m/min
    inp.cbd = c.cbd;
    // Cheap reject before the crown ellipse is built at all.
    inp.fm10Ros = 0;
    if (evaluateCrownFire(inp, out).type === CrownFire.None) return ftPerMinToMetersPerSec(surfFtMin);
    this.ensureCrownHead();
    const dim = ellipseDimensions(c.fm10Head, c.crownEcc, this.crownDim);
    const v = richardsVelocity(dim, c.headUx, c.headUy, tangentX, tangentY, this.crownVel);
    inp.fm10Ros = Math.hypot(v.vx, v.vy) * 0.3048; // ft/min -> m/min
    evaluateCrownFire(inp, out);
    return out.ros / 60; // m/min -> m/s
  }

  /**
   * The bed options for one fuel: with the cured-herbaceous load transfer, or
   * without. The gate is `dynamicHerbLoad` when the scenario forced it either
   * way, else the fuel model's own `dynamic` flag (`docs/science.md` §3c).
   *
   * There is exactly one of these because a fuel must have exactly **one** dead
   * bed: the transfer feeds both the spread bed and the flame-residence
   * characteristic SAV, and Phase 9b put it inside `deadFuelBed` precisely so the
   * same cured grass that carries the fire also sets how long it burns.
   *
   * Two things that look like omissions and are not. The **bed cache needs no new
   * dimension** — its key is `fuelId * 256 + moistureByte`, and this gate is a
   * pure function of `fuelId`, as is `residenceSecById`'s. And the **FM10 crown
   * proxy is unaffected** whichever way the gate falls: FM10 carries no live
   * herbaceous load, so there is nothing to transfer.
   */
  private bedOptionsFor(rf: RothermelFuel): BedOptions | undefined {
    return (this.forceHerbLoad ?? rf.dynamic === true) ? this.curedBedOptions : this.staticBedOptions;
  }

  /** The prepared surface bed for a fuel at a dead-moisture byte (cached; see `bedCache`). */
  surfaceBedFor(fuelId: number, rf: RothermelFuel, moistureByte: number): BedIntermediates {
    const key = fuelId * 256 + moistureByte;
    let bed = this.bedCache.get(key);
    if (bed === undefined) {
      bed = prepareFuelBed(fuelBed(rf, byteToFraction(moistureByte), this.liveMoisture, this.bedOptionsFor(rf)));
      this.bedCache.set(key, bed);
    }
    return bed;
  }

  /**
   * The FM10 crown-proxy bed for a cell, or null when the cell cannot crown.
   *
   * It gets the same bed moisture as the surface bed on purpose: Rothermel's
   * 1991 crown rate runs FM10 as a stand-in for crown fuel at the *site's*
   * moistures, so the per-class dead split and the greenness curve belong here too
   * (`docs/science.md` §3a). Foliar moisture is separate — it lives on the canopy
   * stand and is untouched by this.
   */
  crownBedFor(canopyByte: number, moistureByte: number): BedIntermediates | null {
    if (!this.crownEnabled) return null;
    if (canopyBulkDensity(canopyByte, this.canopy) < MIN_CROWN_CBD) return null;
    let bed = this.crownBedCache[moistureByte];
    if (bed === undefined) {
      bed = prepareFuelBed(fuelBed(FM10, byteToFraction(moistureByte), this.liveMoisture, this.bedOptionsFor(FM10)));
      this.crownBedCache[moistureByte] = bed;
    }
    return bed;
  }

  /** Canopy bulk density at a cell, against this model's stand. */
  cbdFor(canopyByte: number): number {
    return canopyBulkDensity(canopyByte, this.canopy);
  }

  /**
   * Factor that turns this cell's world wind into midflame wind: 1 under the
   * `'midflame'` convention, else the Albini–Baughman WAF for the cell's fuel-bed
   * depth and the canopy over it (cached per fuel id × canopy byte).
   */
  midflameFactor(fuelId: number, rf: RothermelFuel, canopyByte: number): number {
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
  openWind(rf: RothermelFuel, w: number, waf: number): number {
    if (this.windReference === 'open') return w;
    const u = unshelteredWaf(rf.depth);
    return u > 0 ? (w * waf) / u : 0;
  }

  /**
   * The cell's own terrain slope, by central differences on `elevation` (clamped
   * to a one-sided difference at the map edge). Leaves the magnitude as rise/run
   * in `grad.tan` and the **uphill** unit vector in `grad.ux/uy`, which is what
   * the wind–slope vector sum wants.
   *
   * The per-ray law instead took the rise from the ignited neighbour to this
   * cell. Both are defensible discretizations; the ellipse needs a single slope
   * *vector* per site, and Rothermel's φ_s is a property of the site, so the
   * gradient is the more faithful of the two (Phase-8 plan §"Design decisions").
   */
  cellGradient(
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
   * Whether a fuel id carries fire at all, from {@link burnableById}. Used by the
   * raster's knight-move gate, which needs it twice per long ray in the hot loop,
   * and by the marker front's barrier guard.
   */
  burnableFuel(fuelId: number): boolean {
    let b = this.burnableById[fuelId];
    if (b < 0) {
      b = this.fuel.getParams(fuelId).burnable ? 1 : 0;
      this.burnableById[fuelId] = b;
    }
    return b === 1;
  }

  /**
   * Flame residence time [s] for a fuel id — the cosmetic burnout clock, cached
   * per id. `rf` is the fuel's Rothermel descriptor, or null when it has none
   * (then it cannot sustain flame and burns out immediately).
   */
  residenceSec(fuelId: number, rf: RothermelFuel | null | undefined): number {
    let sec = this.residenceSecById.get(fuelId);
    if (sec === undefined) {
      sec = rf ? flameResidenceTime(bedSAV(rf, this.bedOptionsFor(rf))) * 60 : 0;
      this.residenceSecById.set(fuelId, sec);
    }
    return sec;
  }
}

/**
 * Characteristic SAV σ of a fuel's dead bed — drives the residence time. Moisture
 * is irrelevant to σ, so the bed is assembled at 0 just to reuse {@link deadFuelBed}.
 * The options still matter: a cured herbaceous load transfer adds a real fourth
 * dead particle, and coarser dead fuel burns for longer.
 */
function bedSAV(rf: RothermelFuel, options?: BedOptions): number {
  return characteristicSAV(deadFuelBed(rf, 0, options).particles);
}
