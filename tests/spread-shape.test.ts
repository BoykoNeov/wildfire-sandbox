import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel, ANDERSON_13, fuelBed } from '../src/sim/anderson13';
import { RothermelFireModel, type SpreadShape, type SpreadTemplate } from '../src/sim/rothermelFireModel';
import { prepareFuelBed, windFactorFrom, ftPerMinToMetersPerSec, metersPerSecToFtPerMin } from '../src/sim/rothermel';
import {
  FT_PER_MIN_TO_MPH,
  eccentricity,
  effectiveWindSpeed,
  lengthToBreadthRatio,
} from '../src/sim/fireEllipse';
import { byteToFraction } from '../src/core/moisture';

/**
 * Phase-8 acceptance gates (`docs/plans/phase-8-elliptical-spread.md`): the
 * *shape* a point ignition burns, as opposed to `spread-ros.test.ts`, which
 * pins the *speed* of a planar front.
 *
 * Three separate things are measured, because three separate things were wrong:
 *  - **aspect** — under a steady wind the fire should be an ellipse whose
 *    length-to-breadth ratio is Anderson (1983)'s. Defect 1, fixed in Phase 8 by
 *    the elliptical directional law.
 *  - **isotropy** — with no wind and no slope the fire should be a circle. The
 *    raster can only be a polygon; these pin how far off. Defect 2, narrowed in
 *    Phase 8b by the 16-ray template.
 *  - **speed** — none of the above may make the fire *faster*. A 16-ray template
 *    on the Phase-2 single accumulator runs 1.45× too fast (see
 *    {@link SpreadTemplate}), which is why the accumulators are now per-ray, and
 *    why the windless radii below are asserted in absolute cells and not only as
 *    ratios. `spread-ros.test.ts` pins the same property for a planar front.
 */

const FM = 1; // FM1 short grass — a clean single-class dead bed, fast enough to run far.
const MOIST_BYTE = 15; // ≈ 6% dead-fuel moisture.
const LIVE_MOISTURE = 1.0; // the model's own default

/** Prepared bed for the test fuel — the analytic side of every assertion below. */
function testBed() {
  return prepareFuelBed(fuelBed(ANDERSON_13.get(FM)!, byteToFraction(MOIST_BYTE), LIVE_MOISTURE));
}

/** A flat, homogeneous field lit at the centre, with a uniform wind [m/s]. */
function pointIgnitionWorld(size: number, cellSize: number, windU: number, windV: number): WorldState {
  const world = createWorld({ width: size, height: size, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST_BYTE);
  world.layers.windU.data.fill(windU);
  world.layers.windV.data.fill(windV);
  const c = size >> 1;
  world.layers.fire.set(c, c, FireState.Burning);
  return world;
}

function isIgnited(world: WorldState, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return false;
  const s = world.layers.fire.get(x, y);
  return s === FireState.Burning || s === FireState.Burned;
}

/**
 * How far the burn reached along a ray from the centre, in cells: walk outward
 * in half-cell steps and stop at the first sample that never ignited.
 */
function radiusAlong(world: WorldState, angleRad: number): number {
  const c = world.width >> 1;
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  let last = 0;
  for (let r = 0.5; r < c; r += 0.5) {
    if (!isIgnited(world, Math.round(c + r * dx), Math.round(c + r * dy))) break;
    last = r;
  }
  return last;
}

/** Bounding extents of the burn, in cells, relative to the ignition point. */
function extents(world: WorldState): { head: number; back: number; halfWidth: number } {
  const c = world.width >> 1;
  let head = 0;
  let back = 0;
  let halfWidth = 0;
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      if (!isIgnited(world, x, y)) continue;
      head = Math.max(head, x - c);
      back = Math.max(back, c - x);
      halfWidth = Math.max(halfWidth, Math.abs(y - c));
    }
  }
  return { head, back, halfWidth };
}

function run(
  world: WorldState,
  shape: SpreadShape,
  steps: number,
  dt: number,
  spreadTemplate: SpreadTemplate = 'template16',
): void {
  const model = new RothermelFireModel(new Anderson13FuelModel(), { spreadShape: shape, spreadTemplate });
  new Simulation(world, [model]).run(steps, dt);
}

/** Burn radius, in cells, at nine angles from due east to due north. */
function radiusProfile(world: WorldState): number[] {
  const out: number[] = [];
  for (let k = 0; k <= 8; k++) out.push(radiusAlong(world, (k * Math.PI) / 16));
  return out;
}

describe('spread shape — isotropy with no wind and no slope', () => {
  const dt = 1;
  const ticksPerCell = 4;
  const steps = 100; // ideal radius = 25 cells

  function windlessProfile(shape: SpreadShape, template: SpreadTemplate = 'template16'): number[] {
    const r0 = ftPerMinToMetersPerSec(testBed().rateOfSpreadNoWindSlope);
    const world = pointIgnitionWorld(121, ticksPerCell * dt * r0, 0, 0);
    run(world, shape, steps, dt, template);
    return radiusProfile(world);
  }

  it('the two laws are identical with no wind and no slope', () => {
    // The degenerate case is the tightest constraint on the ellipse: with no
    // wind and no slope the resultant is zero, so LB = 1, E = 0 and
    // R(θ) = R_head = R₀ in every direction — exactly what the per-direction law
    // computes. Anything else means the ellipse is wrong at its own limit.
    expect(windlessProfile('elliptical')).toEqual(windlessProfile('perDirection'));
  });

  it('never outruns R₀ in any direction — the 16-ray overspeed guard', () => {
    // THE regression this test file exists for since Phase 8b. The ideal windless
    // radius is exactly `steps / ticksPerCell` = 25 cells: the fire spreads at R₀
    // and nothing may make it faster. Bolting the knight rays onto the Phase-2
    // *single* accumulator does exactly that — a cell picks up credit from its
    // knight neighbour two columns back (which lights a whole crossing-period
    // early, at 1/√5 of the cardinal rate) and then adds the cardinal rate on top,
    // landing at 1/(1 + 1/√5) = 0.69 of the correct crossing time. Measured then:
    // radii of 33–36 cells, i.e. +32 % to +44 %. Per-ray accumulators are what
    // make the front a shortest path again, and this is the assertion that says
    // so. See {@link SpreadTemplate}.
    const ideal = steps / ticksPerCell; // 25
    for (const template of ['ring8', 'template16'] as const) {
      const profile = windlessProfile('elliptical', template);
      expect(Math.max(...profile)).toBeLessThanOrEqual(ideal * 1.12);
      expect(profile[0]).toBeGreaterThan(ideal * 0.95); // …and it really did run
    }
    // The 16-ray front is *inscribed*: it reaches R₀·t on the rays and falls short
    // between them, never past. The 8-ring alone is not — its diagonal overshoots
    // by 10 % (27.5 cells against the ideal 25), the accumulator artefact this
    // file has documented since Phase 8.
    expect(Math.max(...windlessProfile('elliptical', 'template16'))).toBeLessThanOrEqual(ideal);
    expect(Math.max(...windlessProfile('elliptical', 'ring8'))).toBeGreaterThan(ideal);
  });

  it('is a 16-gon inscribed in the circle: ~9% anisotropy, down from ~17%', () => {
    const profile = windlessProfile('elliptical');
    const east = profile[0];
    expect(east).toBeGreaterThan(20); // the fire actually ran

    // Measured at 0 / 11.25 / 22.5 / 33.75 / 45°, relative to due east:
    //   16 rays: 1.000 / 0.940 / 0.960 / 0.960 / 0.920   (max/min 1.087)
    //    8 rays: 1.000 / 0.940 / 0.960 / 1.020 / 1.100   (max/min 1.170)
    // The 8-ring's >1 entries are the accumulator beating the graph shortest path
    // on the diagonals; per-ray accumulators remove that, so what is left is the
    // honest polygon defect: every direction at or inside the true circle. What
    // is left is per-tick quantization, not the graph metric — a cell fires on the
    // tick its accumulator passes 1, so a ray whose crossing time is not a whole
    // number of ticks always fires late. Here a cardinal step is exactly 4 ticks
    // and loses nothing, while a diagonal step takes 4√2 = 5.66 and rounds to 6,
    // which is the ~6 % shortfall at 45°.
    const rel = profile.map((r) => r / east);
    expect(Math.max(...rel)).toBeLessThanOrEqual(1.0); // inscribed: nothing overshoots
    expect(Math.min(...rel)).toBeGreaterThan(0.90);
    expect(Math.max(...rel) / Math.min(...rel)).toBeLessThan(1.12);

    // Strictly rounder than the 8-ring it replaces.
    const ring8 = windlessProfile('elliptical', 'ring8');
    const relRing8 = ring8.map((r) => r / ring8[0]);
    const spread = (v: number[]): number => Math.max(...v) / Math.min(...v);
    expect(spread(rel)).toBeLessThan(spread(relRing8));
  });
});

describe('spread shape — an ellipse under a steady wind', () => {
  const WIND_MPS = 2; // midflame wind (the model's default reference)

  /** Analytic head rate [m/s] and ellipse geometry for WIND_MPS on flat ground. */
  function analytic() {
    const bi = testBed();
    const phiW = windFactorFrom(bi, metersPerSecToFtPerMin(WIND_MPS));
    const headFtMin = bi.rateOfSpreadNoWindSlope * (1 + phiW);
    const lb = lengthToBreadthRatio(effectiveWindSpeed(bi, phiW) * FT_PER_MIN_TO_MPH);
    return { headMps: ftPerMinToMetersPerSec(headFtMin), lb, ecc: eccentricity(lb) };
  }

  it('back-solves the effective wind to the wind that produced it', () => {
    const bi = testBed();
    const u = metersPerSecToFtPerMin(WIND_MPS);
    expect(effectiveWindSpeed(bi, windFactorFrom(bi, u))).toBeCloseTo(u, 4);
  });

  it('burns a length-to-breadth ratio matching Anderson 1983', () => {
    const { headMps, lb, ecc } = analytic();
    expect(lb).toBeGreaterThan(1.2); // this wind really does stretch the fire

    const dt = 1;
    const ticksPerCell = 4;
    const cellSize = ticksPerCell * dt * headMps; // head advances 1 cell / 4 ticks
    const steps = 160; // ideal head = 40 cells
    const world = pointIgnitionWorld(121, cellSize, WIND_MPS, 0);
    run(world, 'elliptical', steps, dt);

    const { head, back, halfWidth } = extents(world);
    expect(head).toBeGreaterThan(35); // the head really ran

    // The ellipse has the ignition point at its rear focus: semi-major
    // a = (head + back)/2 and semi-minor b = a/LB, so (head + back)/(2·halfWidth)
    // is LB. The measured value runs a little high because the front is the
    // convex hull of eight rays and the ellipse's widest point falls between two
    // of them (plan §"Defect 2"): +7% here, growing past LB ≈ 2.5.
    const measuredLb = (head + back) / (2 * halfWidth);
    expect(measuredLb).toBeGreaterThan(lb * 0.9);
    expect(measuredLb).toBeLessThan(lb * 1.2);

    // Backing spread is the visible payoff: R_back/R_head = (1−E)/(1+E).
    const measuredBackRatio = back / head;
    const analyticBackRatio = (1 - ecc) / (1 + ecc);
    expect(measuredBackRatio).toBeGreaterThan(analyticBackRatio * 0.7);
    expect(measuredBackRatio).toBeLessThan(analyticBackRatio * 1.3);
  });

  it('responds to wind at all — which the old per-direction law does not', () => {
    // The reason Phase 8 exists. Projecting the wind onto each ray produces a
    // fire whose *shape* barely changes with wind speed: every direction more
    // than 90° off the wind still gets the full no-wind R₀, so the flanks and
    // the back are pinned to R₀ while only the head accelerates, and the
    // measured length-to-breadth ratio sits near 1.5 whatever the wind does.
    const dt = 1;
    const steps = 160;

    /** Analytic Anderson length-to-breadth at a given midflame wind. */
    const analyticLb = (wind: number): number => {
      const bi = testBed();
      return lengthToBreadthRatio(
        effectiveWindSpeed(bi, windFactorFrom(bi, metersPerSecToFtPerMin(wind))) * FT_PER_MIN_TO_MPH,
      );
    };

    /** Measured length-to-breadth at a given midflame wind, under one law. */
    const measure = (wind: number, shape: SpreadShape, template: SpreadTemplate = 'template16'): number => {
      const bi = testBed();
      const headMps = ftPerMinToMetersPerSec(
        bi.rateOfSpreadNoWindSlope * (1 + windFactorFrom(bi, metersPerSecToFtPerMin(wind))),
      );
      const world = pointIgnitionWorld(121, 4 * dt * headMps, wind, 0);
      run(world, shape, steps, dt, template);
      const { head, back, halfWidth } = extents(world);
      return (head + back) / (2 * halfWidth);
    };

    const oldLow = measure(2, 'perDirection');
    const oldHigh = measure(5, 'perDirection');
    const newLow = measure(2, 'elliptical');
    const newHigh = measure(5, 'elliptical');

    // Old law: flat. Tripling the wind barely moves the shape (1.50 → 1.54).
    expect(oldHigh / oldLow).toBeLessThan(1.2);

    // New law: the fire stretches as the wind rises, and it tracks the *analytic*
    // ratio rather than any particular measured constant. Anderson says
    // 3.19/1.50 = 2.13 between these two winds; the raster measures 2.55, high by
    // a fifth because the discretization still loses more flank width at LB 3.2
    // than at LB 1.5. (Pinning the raw measured ratio instead would be pinning
    // the discretization error, which is exactly what Phase 8b changed.)
    const analyticRatio = analyticLb(5) / analyticLb(2);
    expect(analyticRatio).toBeGreaterThan(2); // this wind range really does stretch it
    expect(newHigh / newLow).toBeGreaterThan(analyticRatio * 0.8);
    expect(newHigh / newLow).toBeLessThan(analyticRatio * 1.5);
    expect(newLow).toBeGreaterThan(oldLow);
  });

  it('the 16-ray template is what makes a strongly wind-driven fire wide enough', () => {
    // The Phase-8b acceptance gate. The 8-ray hull cuts the corner at the
    // ellipse's widest point (~18° off the head, between the 0° and 45° rays), so
    // it understates flank width, and the error grows with the aspect ratio. The
    // knight rays at 26.57° land close to that point.
    //
    // Measured error against the analytic Anderson LB, 8 rays vs 16:
    //   wind      1     1.5   2     2.5   3     4     5 m/s
    //   analytic  1.21  1.34  1.50  1.69  1.91  2.46  3.19
    //   ring8     +4%   +3%   +7%   +8%   +12%  +39%  +61%
    //   16 rays   +4%   +3%   +7%   +8%   +12%  +4%   +28%
    // Identical up to 3 m/s — below LB ≈ 2 the widest point is close enough to the
    // 45° ray that the extra rays buy nothing — and the whole gain is above it,
    // which is where the old error was worst. Both are still *narrow*-biased,
    // i.e. they understate burned area.
    const dt = 1;
    const WIND = 5;
    const bi = testBed();
    const headMps = ftPerMinToMetersPerSec(
      bi.rateOfSpreadNoWindSlope * (1 + windFactorFrom(bi, metersPerSecToFtPerMin(WIND))),
    );
    const lb = lengthToBreadthRatio(
      effectiveWindSpeed(bi, windFactorFrom(bi, metersPerSecToFtPerMin(WIND))) * FT_PER_MIN_TO_MPH,
    );
    expect(lb).toBeGreaterThan(3); // a properly stretched fire

    const measure = (template: SpreadTemplate): number => {
      const world = pointIgnitionWorld(121, 4 * dt * headMps, WIND, 0);
      run(world, 'elliptical', 160, dt, template);
      const { head, back, halfWidth } = extents(world);
      return (head + back) / (2 * halfWidth);
    };
    const err = (m: number): number => Math.abs(m / lb - 1);

    expect(err(measure('ring8'))).toBeGreaterThan(0.5); // the defect being fixed
    expect(err(measure('template16'))).toBeLessThan(0.35); // …roughly halved
    expect(err(measure('template16'))).toBeLessThan(err(measure('ring8')) / 2);
  });
});
