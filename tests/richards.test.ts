import { describe, it, expect } from 'vitest';
import { ellipseDimensions, richardsVelocity, type EllipseDimensions, type MarkerVelocity } from '../src/sim/richards';
import { backingRate, eccentricity, ellipticalRate, lengthToBreadthRatio } from '../src/sim/fireEllipse';

/**
 * Richards' elliptical growth equations (`src/sim/richards.ts`), the propagation
 * half of Phase 11. Two things are pinned here, and they are different in kind:
 *
 *  1. **The dimensions agree with the ellipse this repo already ships.** FARSITE
 *     reaches the semi-axes through Alexander's head/backing ratio; we reach them
 *     through the eccentricity `fireEllipse.ts` already computes. The plan claims
 *     these are the same thing (§2b); these tests are the claim, checked.
 *
 *  2. **The handedness and winding are right.** This is the failure mode the
 *     whole phase has to be careful about: a *mirrored* ellipse has identical
 *     anisotropy, identical length-to-breadth at every wind speed and the same
 *     radius at every angle off the axis — so every shape measurement passes
 *     while the fire runs off in the wrong direction. Only a **signed** direction
 *     check can see it, which is what `an oblique head direction is not mirrored`
 *     below is for.
 */

const dim: EllipseDimensions = { a: 0, b: 0, c: 0 };
const vel: MarkerVelocity = { vx: 0, vy: 0 };

describe('Richards growth — ellipse dimensions', () => {
  it('a windless fire is a circle of radius R', () => {
    const d = ellipseDimensions(3, 0, dim);
    expect(d.a).toBe(3);
    expect(d.b).toBe(3);
    expect(d.c).toBe(0);
  });

  it('the head reaches R and the back reaches the backing rate', () => {
    // a + c is the far end of the ellipse from the focus, a − c the near end.
    for (const lb of [1.5, 2, 3, 5, 8]) {
      const e = eccentricity(lb);
      const d = ellipseDimensions(10, e, dim);
      expect(d.a + d.c).toBeCloseTo(10, 10);
      expect(d.a - d.c).toBeCloseTo(backingRate(10, e), 10);
    }
  });

  it('the axes satisfy the ellipse identities c = a·E and b = a·√(1−E²)', () => {
    for (const u of [1, 3, 6, 12]) {
      const e = eccentricity(lengthToBreadthRatio(u));
      const d = ellipseDimensions(7, e, dim);
      expect(d.c).toBeCloseTo(d.a * e, 12);
      expect(d.b).toBeCloseTo(d.a * Math.sqrt(1 - e * e), 12);
      // …and the semi-minor is the semi-major over the length-to-breadth ratio,
      // which is where FARSITE gets it from — the two routes agree.
      expect(d.b).toBeCloseTo(d.a / lengthToBreadthRatio(u), 10);
    }
  });
});

/**
 * A marker at angle `phi` (measured on screen, counter-clockwise) on a circle,
 * with the tangent taken as `previous − next` for a ring wound counter-clockwise
 * as seen on screen. On screen y grows downward, so a counter-clockwise sweep is
 * `(cos φ, −sin φ)` with φ increasing, and the tangent points along `(sin φ, cos φ)`.
 */
function tangentAt(phi: number): [number, number] {
  return [Math.sin(phi), Math.cos(phi)];
}

describe('Richards growth — the four cases that pin the convention', () => {
  const R = 5;

  it('a windless marker moves outward at R along the normal', () => {
    const d = ellipseDimensions(R, 0, dim);
    for (const phi of [0, Math.PI / 4, Math.PI / 2, 2, 4, 5.9]) {
      const [tx, ty] = tangentAt(phi);
      const v = richardsVelocity(d, 1, 0, tx, ty, vel);
      // Outward at this point on the circle is (cos φ, −sin φ).
      expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(R, 10);
      expect(v.vx).toBeCloseTo(R * Math.cos(phi), 10);
      expect(v.vy).toBeCloseTo(-R * Math.sin(phi), 10);
    }
  });

  it('the head marker runs at exactly the Rothermel head rate', () => {
    const e = eccentricity(lengthToBreadthRatio(6));
    const d = ellipseDimensions(R, e, dim);
    // Head along +x; the marker at the head has its tangent across the head.
    const [tx, ty] = tangentAt(0);
    const v = richardsVelocity(d, 1, 0, tx, ty, vel);
    expect(v.vx).toBeCloseTo(R, 10);
    expect(v.vy).toBeCloseTo(0, 12);
  });

  it('the back marker backs into the wind at the backing rate', () => {
    const e = eccentricity(lengthToBreadthRatio(6));
    const d = ellipseDimensions(R, e, dim);
    const [tx, ty] = tangentAt(Math.PI);
    const v = richardsVelocity(d, 1, 0, tx, ty, vel);
    expect(v.vx).toBeCloseTo(-backingRate(R, e), 10);
    expect(v.vy).toBeCloseTo(0, 12);
  });

  it('the flank marker widens at the semi-minor axis and drifts downwind at c', () => {
    const e = eccentricity(lengthToBreadthRatio(6));
    const d = ellipseDimensions(R, e, dim);
    // The widest marker is the one whose tangent lies *along* the head, which on
    // a ring is the marker directly above the centre on screen.
    const [tx, ty] = tangentAt(Math.PI / 2);
    const v = richardsVelocity(d, 1, 0, tx, ty, vel);
    // Two components, and the second is the one that is easy to forget: the
    // marker widens at `b` across the head AND is carried downwind at `c`, the
    // focus offset. That drift is not a fudge — it is what makes the envelope
    // come out as an ellipse about its *focus* rather than about its centre,
    // which is the shape a point ignition actually grows (Anderson 1983). The
    // envelope test at the bottom of this file is the check on that.
    expect(v.vy).toBeCloseTo(-d.b, 10);
    expect(v.vx).toBeCloseTo(d.c, 10);
    // The flank is genuinely wide: several times the backing rate, well under the head.
    expect(d.b).toBeGreaterThan(backingRate(R, e) * 2);
    expect(d.b).toBeLessThan(R);
  });
});

describe('Richards growth — handedness', () => {
  it('a ring wound counter-clockwise on screen expands', () => {
    // The expansion gate, stated as the plan asks: every marker of a windless
    // ring must have a velocity pointing away from the centre.
    const d = ellipseDimensions(2, 0, dim);
    for (let k = 0; k < 16; k++) {
      const phi = (2 * Math.PI * k) / 16;
      const [tx, ty] = tangentAt(phi);
      const v = richardsVelocity(d, 1, 0, tx, ty, vel);
      const outX = Math.cos(phi);
      const outY = -Math.sin(phi);
      expect(v.vx * outX + v.vy * outY).toBeGreaterThan(0);
    }
  });

  it('an oblique head direction is not mirrored', () => {
    // THE test of this file. Head 30° above +x on screen — i.e. (cos30, −sin30),
    // because screen y points down. The head marker must travel along +30°, not
    // −30°: a mirrored ellipse passes every magnitude check ever written.
    const theta = Math.PI / 6;
    const hx = Math.cos(theta);
    const hy = -Math.sin(theta);
    const e = eccentricity(lengthToBreadthRatio(8));
    const d = ellipseDimensions(4, e, dim);
    // The head marker sits at angle θ on the ring, so its tangent is tangentAt(θ).
    const [tx, ty] = tangentAt(theta);
    const v = richardsVelocity(d, hx, hy, tx, ty, vel);
    expect(v.vx).toBeCloseTo(4 * hx, 8);
    expect(v.vy).toBeCloseTo(4 * hy, 8);
    // Explicitly: the y component is negative (upward on screen), which is what a
    // mirror would flip. Asserting only the magnitude would not catch it.
    expect(v.vy).toBeLessThan(0);
  });
});

describe('Richards growth — the envelope is the analytic spread ellipse', () => {
  it('a point ignition traces R(θ) = R_head·(1−E)/(1−E·cos θ)', () => {
    // Integrate a marker ring forward and compare its radius at each angle with
    // the focus form `fireEllipse.ts` already ships — the two are different
    // computations of the same ellipse (normal form vs focus form), so this is
    // the real cross-check on the propagation, not a restatement of it.
    const R = 1;
    const e = eccentricity(lengthToBreadthRatio(4));
    const d = ellipseDimensions(R, e, dim);
    const T = 100;
    // Forward Euler over a ring: the step count is set by accuracy near the
    // start, where a ring of radius 1e-3 has enormous curvature, and the marker
    // count only by the chord error (at N = 240 a polygon's inradius is 0.99991
    // of its circumradius, so it contributes nothing).
    const steps = 16000;
    const dt = T / steps;
    const N = 240;
    const r0 = 1e-3;

    const xs = new Float64Array(N);
    const ys = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const phi = (2 * Math.PI * k) / N;
      xs[k] = r0 * Math.cos(phi);
      ys[k] = -r0 * Math.sin(phi);
    }
    const nx = new Float64Array(N);
    const ny = new Float64Array(N);
    for (let s = 0; s < steps; s++) {
      for (let k = 0; k < N; k++) {
        const p = k === 0 ? N - 1 : k - 1;
        const n = k === N - 1 ? 0 : k + 1;
        const v = richardsVelocity(d, 1, 0, xs[p] - xs[n], ys[p] - ys[n], vel);
        nx[k] = xs[k] + v.vx * dt;
        ny[k] = ys[k] + v.vy * dt;
      }
      xs.set(nx);
      ys.set(ny);
    }

    // The ignition point is the ellipse's rear focus, and it is where we started,
    // so a marker's distance from the origin is R(θ)·T for its own θ.
    for (let k = 0; k < N; k += 15) {
      const r = Math.hypot(xs[k], ys[k]);
      const cosTheta = xs[k] / r; // head is +x
      const expected = ellipticalRate(R, e, cosTheta) * T;
      expect(Math.abs(r - expected) / expected).toBeLessThan(0.01);
    }
  });
});
