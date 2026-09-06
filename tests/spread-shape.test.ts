import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { Anderson13FuelModel, ANDERSON_13, fuelBed } from '../src/sim/anderson13';
import { RothermelFireModel, type SpreadShape } from '../src/sim/rothermelFireModel';
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
 * Two separate things are measured, because two separate things were wrong:
 *  - **isotropy** — with no wind and no slope the fire should be a circle. It is
 *    an octagon, and this test pins how far off (the grid metric, defect 2 in
 *    the plan: deliberately not fixed).
 *  - **aspect** — under a steady wind the fire should be an ellipse whose
 *    length-to-breadth ratio is Anderson (1983)'s. That is defect 1, the one
 *    this phase fixes.
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

function run(world: WorldState, shape: SpreadShape, steps: number, dt: number): void {
  new Simulation(world, [new RothermelFireModel(new Anderson13FuelModel(), { spreadShape: shape })]).run(steps, dt);
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

  function windlessProfile(shape: SpreadShape): number[] {
    const r0 = ftPerMinToMetersPerSec(testBed().rateOfSpreadNoWindSlope);
    const world = pointIgnitionWorld(121, ticksPerCell * dt * r0, 0, 0);
    run(world, shape, steps, dt);
    return radiusProfile(world);
  }

  it('the two laws are identical with no wind and no slope', () => {
    // The degenerate case is the tightest constraint on the ellipse: with no
    // wind and no slope the resultant is zero, so LB = 1, E = 0 and
    // R(θ) = R_head = R₀ in every direction — exactly what the per-direction law
    // computes. Anything else means the ellipse is wrong at its own limit.
    expect(windlessProfile('elliptical')).toEqual(windlessProfile('perDirection'));
  });

  it('is anisotropic by ~16%: a rounded square bulging on the diagonals', () => {
    const profile = windlessProfile('elliptical');
    const east = profile[0];
    expect(east).toBeGreaterThan(20); // the fire actually ran

    // Measured (plan §"Defect 2"): 1.000 / 0.941 / 0.960 / 1.020 / 1.089 at
    // 0 / 11.25 / 22.5 / 33.75 / 45°. This is NOT the textbook weighted-8
    // octagon (exact on the rays, 92.4% at 22.5°): the `progress` accumulator
    // beats the graph shortest path on the diagonals, because a cell that has
    // been accumulating from its diagonal predecessor switches to the faster
    // cardinal rate the moment its cardinal neighbour ignites. The front is
    // therefore long on the diagonals and short at 11.25°.
    const rel = profile.map((r) => r / east);
    expect(Math.max(...rel)).toBeLessThan(1.15); // diagonal bulge
    expect(Math.min(...rel)).toBeGreaterThan(0.90); // the 11.25° shortfall
    expect(Math.max(...rel) / Math.min(...rel)).toBeLessThan(1.25);

    // The diagonal really is the long direction, and 11.25° the short one.
    expect(rel[4]).toBeGreaterThan(rel[0]); // 45° > 0°
    expect(rel[1]).toBeLessThan(rel[0]); // 11.25° < 0°
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
    // The reason this phase exists. Projecting the wind onto each ray produces a
    // fire whose *shape* barely changes with wind speed: every direction more
    // than 90° off the wind still gets the full no-wind R₀, so the flanks and
    // the back are pinned to R₀ while only the head accelerates, and the
    // measured length-to-breadth ratio sits near 1.5 whatever the wind does.
    const dt = 1;
    const steps = 160;

    /** Measured length-to-breadth at a given midflame wind, under one law. */
    const measure = (wind: number, shape: SpreadShape): number => {
      const bi = testBed();
      const headMps = ftPerMinToMetersPerSec(
        bi.rateOfSpreadNoWindSlope * (1 + windFactorFrom(bi, metersPerSecToFtPerMin(wind))),
      );
      const world = pointIgnitionWorld(121, 4 * dt * headMps, wind, 0);
      run(world, shape, steps, dt);
      const { head, back, halfWidth } = extents(world);
      return (head + back) / (2 * halfWidth);
    };

    const oldLow = measure(2, 'perDirection');
    const oldHigh = measure(5, 'perDirection');
    const newLow = measure(2, 'elliptical');
    const newHigh = measure(5, 'elliptical');

    // Old law: flat. Tripling the wind barely moves the shape.
    expect(oldHigh / oldLow).toBeLessThan(1.2);
    // New law: the fire stretches out as the wind rises.
    expect(newHigh / newLow).toBeGreaterThan(2.5);
    // …and it tracks the analytic ratio, not the old law's constant.
    expect(newLow).toBeGreaterThan(oldLow);
  });
});
