import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/core/world';
import { WindParticles } from '../src/render/overlay';

/**
 * The wind streamlines (Phase-7 part-2 item E) are a browser-only overlay, but
 * their advection is deliberately split out of the drawing so it can be pinned
 * here with no canvas: the particles must move downwind, must never leave the
 * grid (an out-of-bounds sample would poison a position with NaN for the rest of
 * the run, silently), and must be reproducible without ever touching the sim's
 * RNG.
 */

function windyWorld(u: number, v: number, size = 64) {
  const world = createWorld({ width: size, height: size, seed: 1234 });
  world.layers.windU.data.fill(u);
  world.layers.windV.data.fill(v);
  return world;
}

/** Advance in 1/60 s frames, the way the browser frame loop does. */
function run(wp: WindParticles, world: ReturnType<typeof windyWorld>, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) wp.update(world, 1 / 60);
}

describe('wind streamlines', () => {
  it('advects particles downwind at the documented gain', () => {
    const world = windyWorld(5, 0);
    const wp = new WindParticles(world, 200);
    const before = Float32Array.from(wp.positions.x);
    const yBefore = Float32Array.from(wp.positions.y);
    run(wp, world, 0.5);
    const { x, y } = wp.positions;

    // 5 m/s × GAIN 1.2 cells/s per m/s × 0.5 s = 3 cells east, none north/south.
    // Particles that respawned mid-run (age-out, or off the east edge) are not
    // part of the claim, so require it of the clear majority.
    let moved = 0;
    for (let p = 0; p < x.length; p++) {
      const dx = x[p] - before[p];
      if (Math.abs(dx - 3) < 0.05 && Math.abs(y[p] - yBefore[p]) < 1e-6) moved++;
    }
    expect(moved).toBeGreaterThan(0.7 * x.length);
  });

  it('keeps every particle on the grid and finite, even blown hard off one edge', () => {
    const world = windyWorld(20, 20, 32); // fast enough to cross a 32² map repeatedly
    const wp = new WindParticles(world, 300);
    run(wp, world, 20);
    const { x, y } = wp.positions;
    for (let p = 0; p < x.length; p++) {
      expect(Number.isFinite(x[p])).toBe(true);
      expect(Number.isFinite(y[p])).toBe(true);
      // A particle may sit up to one sub-step beyond the edge before the next
      // update respawns it; it must never be far outside, and never NaN.
      expect(x[p]).toBeGreaterThan(-1);
      expect(y[p]).toBeGreaterThan(-1);
      expect(x[p]).toBeLessThan(world.width + 1);
      expect(y[p]).toBeLessThan(world.height + 1);
    }
  });

  it('is reproducible and never draws on the simulation RNG', () => {
    const a = windyWorld(3, -4);
    const b = windyWorld(3, -4);
    const rngBefore = a.rng.next();

    const wpA = new WindParticles(a, 128);
    const wpB = new WindParticles(b, 128);
    run(wpA, a, 3);
    run(wpB, b, 3);
    expect(Array.from(wpA.positions.x)).toEqual(Array.from(wpB.positions.x));
    expect(Array.from(wpA.positions.y)).toEqual(Array.from(wpB.positions.y));

    // Spawning and advecting 128 particles for 3 s consumed no RNG draws, so the
    // next number out of `a.rng` is the one that followed `rngBefore`.
    const fresh = windyWorld(3, -4);
    expect(fresh.rng.next()).toBe(rngBefore);
    expect(a.rng.next()).toBe(fresh.rng.next());
  });

  it('caps how far one long frame can carry a particle', () => {
    const world = windyWorld(12, 0);
    const wp = new WindParticles(world, 64);
    const before = Float32Array.from(wp.positions.x);
    wp.update(world, 0.25); // the frame loop's clamped worst case
    const { x } = wp.positions;
    // MAX_TICKS = 8 sub-steps → 12 × 1.2 × 8/60 ≈ 1.92 cells, not the 3.6 a
    // 0.25 s step would give. A handful of particles reach the end of their life
    // inside the window and reappear somewhere unrelated; those aren't the claim.
    let capped = 0;
    for (let p = 0; p < x.length; p++) {
      if (Math.abs(x[p] - before[p] - 1.92) < 0.05) capped++;
    }
    expect(capped).toBeGreaterThan(0.9 * x.length);
  });
});
