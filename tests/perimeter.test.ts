import { describe, it, expect } from 'vitest';
import {
  MIN_RING_VERTICES,
  area,
  densityControl,
  perimeterLength,
  pointInRing,
  seedRing,
  segmentCross,
  signedArea2,
  traverseSegment,
  type Crossing,
  type Ring,
} from '../src/sim/perimeter';

/** Every edge length of the closed ring. */
function edgeLengths(ring: Ring): number[] {
  const { xs, ys } = ring;
  const out: number[] = [];
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    out.push(Math.hypot(xs[i] - xs[j], ys[i] - ys[j]));
  }
  return out;
}

describe('perimeter — winding', () => {
  it('a seeded ring is counter-clockwise on screen, which is a NEGATIVE shoelace here', () => {
    // The sign is the whole point. Screen coordinates are left-handed relative to
    // the textbook frame (y grows downward), so the winding Richards' equations
    // need comes out with the *opposite* shoelace sign to the one a reader
    // expects. Pinning it here is what stops a later "obvious" sign fix.
    const ring = seedRing(10, 10, 3, 16);
    expect(signedArea2(ring)).toBeLessThan(0);
  });

  it('a seeded ring has the area of its circumscribed polygon', () => {
    const ring = seedRing(0, 0, 5, 64);
    // A regular 64-gon of circumradius 5 is within a fraction of a percent of πr².
    expect(area(ring)).toBeCloseTo(Math.PI * 25, 0);
    expect(perimeterLength(ring)).toBeCloseTo(2 * Math.PI * 5, 0);
  });
});

describe('perimeter — density control', () => {
  it('splits edges that have stretched past the target', () => {
    // A long thin ring: the two long edges are far past any sane spacing.
    const ring: Ring = { xs: [0, 20, 20, 0], ys: [0, 0, 1, 1] };
    densityControl(ring, 0.25, 0.5);
    for (const len of edgeLengths(ring)) expect(len).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(ring.xs.length).toBeGreaterThan(80);
  });

  it('drops points that have bunched up below the floor', () => {
    // 200 points around a circle so small that every edge is far too short.
    const ring = seedRing(0, 0, 0.05, 200);
    densityControl(ring, 0.25, 0.5);
    expect(ring.xs.length).toBeLessThan(200);
    expect(ring.xs.length).toBeGreaterThanOrEqual(MIN_RING_VERTICES);
  });

  it('never collapses a ring below the vertex floor', () => {
    // A ring far smaller than the floor would like: it must survive as a ring,
    // not degenerate into a point or a line, or the tangent vanishes and the
    // front stops moving entirely.
    const ring = seedRing(0, 0, 1e-4, 16);
    densityControl(ring, 1, 2);
    expect(ring.xs.length).toBeGreaterThanOrEqual(MIN_RING_VERTICES);
    expect(signedArea2(ring)).toBeLessThan(0); // …and keeps its winding
  });

  it('leaves a well-spaced ring alone', () => {
    const ring = seedRing(0, 0, 4, 50); // edge ≈ 0.50
    const before = ring.xs.length;
    densityControl(ring, 0.25, 0.6);
    expect(ring.xs.length).toBe(before);
  });
});

describe('perimeter — rasterising a segment', () => {
  /** Collect the cells a segment visits. */
  function walk(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
    const cells: Array<[number, number]> = [];
    traverseSegment(x0, y0, x1, y1, (cx, cy) => {
      cells.push([cx, cy]);
    });
    return cells;
  }

  it('visits both endpoint cells and nothing but 4-connected steps between', () => {
    // The no-skip property is what stops the painted burn having holes in it —
    // a Bresenham line would step diagonally past a shared corner and leave one.
    const cases: Array<[number, number, number, number]> = [
      [0.5, 0.5, 9.5, 3.5],
      [9.5, 3.5, 0.5, 0.5],
      [0.1, 0.1, 0.9, 7.9],
      [3.5, 3.5, 3.5, 3.5],
      [2.2, 5.7, -3.4, 1.1],
      [0.5, 0.5, 40.25, -12.75],
    ];
    for (const [x0, y0, x1, y1] of cases) {
      const cells = walk(x0, y0, x1, y1);
      expect(cells[0]).toEqual([Math.floor(x0), Math.floor(y0)]);
      expect(cells[cells.length - 1]).toEqual([Math.floor(x1), Math.floor(y1)]);
      for (let i = 1; i < cells.length; i++) {
        const step = Math.abs(cells[i][0] - cells[i - 1][0]) + Math.abs(cells[i][1] - cells[i - 1][1]);
        expect(step).toBe(1);
      }
    }
  });

  it('covers every cell a dense sampling of the segment falls in', () => {
    const x0 = 1.3;
    const y0 = 2.7;
    const x1 = 11.9;
    const y1 = 8.15;
    const visited = new Set(walk(x0, y0, x1, y1).map(([cx, cy]) => `${cx},${cy}`));
    for (let t = 0; t <= 1; t += 1 / 20000) {
      const cx = Math.floor(x0 + (x1 - x0) * t);
      const cy = Math.floor(y0 + (y1 - y0) * t);
      expect(visited.has(`${cx},${cy}`)).toBe(true);
    }
  });

  it('stops early when the visitor says so', () => {
    let n = 0;
    traverseSegment(0.5, 0.5, 20.5, 0.5, () => {
      n++;
      return n < 3;
    });
    expect(n).toBe(3);
  });
});

describe('perimeter — point in ring and segment crossing', () => {
  it('crossing count places points inside and outside', () => {
    const ring = seedRing(5, 5, 3, 32);
    expect(pointInRing(ring, 5, 5)).toBe(true);
    expect(pointInRing(ring, 7, 5)).toBe(true);
    expect(pointInRing(ring, 9, 5)).toBe(false);
    expect(pointInRing(ring, 5, 0)).toBe(false);
  });

  it('finds where two segments cross, and reports parallel ones as no crossing', () => {
    const out: Crossing = { x: 0, y: 0 };
    expect(segmentCross(0, 0, 4, 4, 0, 4, 4, 0, out)).toBe(true);
    expect(out.x).toBeCloseTo(2, 12);
    expect(out.y).toBeCloseTo(2, 12);
    expect(segmentCross(0, 0, 4, 4, 0, 1, 4, 5, out)).toBe(false); // parallel
    expect(segmentCross(0, 0, 1, 1, 3, 3, 4, 4, out)).toBe(false); // collinear, disjoint
    expect(segmentCross(0, 0, 1, 0, 0.5, 1, 0.5, 2, out)).toBe(false); // misses
  });
});
