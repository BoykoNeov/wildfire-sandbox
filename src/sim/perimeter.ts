/**
 * Pure polygon geometry for the marker fire front — the housekeeping that keeps
 * a Huygens perimeter usable as it grows.
 *
 * "Markers move outward" is the easy 5 % of a marker front. Everything here is
 * the other 95 %: a stretching perimeter loses resolution at the head and wastes
 * it at the back unless points are inserted and removed as it goes, and a front
 * that has moved must be painted into the raster the rest of the sim reads.
 *
 * Ported in spirit from FARSITE 4 (`edigley/farsite`): `newclip.cpp`
 * (`StandardizePolygon::DensityControl` at :1787, `Cross`),
 * `fsxwrast.cpp` (`Rasterize::Overlap`). Divergences from FARSITE are marked
 * where they occur.
 *
 * Coordinates throughout are **cell units** in the world's raster frame — x
 * rightward, y downward, cell `(i, j)` covering `[i, i+1) × [j, j+1)`. Pure
 * functions and plain arrays: no world state, no RNG.
 */

/** A closed marker perimeter: `xs[k], ys[k]` is vertex `k`, implicitly closed. */
export interface Ring {
  xs: number[];
  ys: number[];
}

/**
 * Twice the signed area of the ring (the shoelace sum), in cell units².
 *
 * **The sign is the winding, and the winding is load-bearing** — Richards'
 * equations move a marker outward only for one of the two orderings
 * (`richards.ts`). In this repo's frame (x right, **y down**) the convention is
 * *counter-clockwise as seen on screen*, and because the frame is left-handed
 * relative to the textbook one, that comes out **negative** here. That double
 * negative is exactly the kind of thing that gets flipped twice and still looks
 * plausible, so it is stated rather than implied, and
 * `tests/perimeter.test.ts` pins it.
 */
export function signedArea2(ring: Ring): number {
  const { xs, ys } = ring;
  const n = xs.length;
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += xs[j] * ys[i] - xs[i] * ys[j];
  }
  return s;
}

/** Unsigned area of the ring [cell units²]. */
export function area(ring: Ring): number {
  return Math.abs(signedArea2(ring)) / 2;
}

/** Total edge length of the closed ring [cell units]. */
export function perimeterLength(ring: Ring): number {
  const { xs, ys } = ring;
  const n = xs.length;
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += Math.hypot(xs[i] - xs[j], ys[i] - ys[j]);
  }
  return s;
}

/**
 * Insert and remove vertices so every edge is between `minLen` and `maxLen`,
 * rewriting `ring` in place.
 *
 * **Why both halves.** A wind-driven front stretches: the head races away and
 * its edges grow until neighbouring markers are cells apart, at which point the
 * front is a coarse polygon and the raster it paints has holes in it. Meanwhile
 * the backing edge barely moves and accumulates points that cost time and say
 * nothing. FARSITE's `DensityControl` does the same job.
 *
 * **Divergence from FARSITE, stated.** FARSITE derives its target resolution
 * from the *mean active segment length* of the fire itself, floored at 1 m and
 * divided by 1.4 for inward-burning rings (`fsxwmech.cpp:540–578`). Here the
 * target is a fixed fraction of the cell size, handed in by the fire model. The
 * reason is that our resolution requirement is not aesthetic but a **rasterising
 * one**: an edge longer than about half a cell can straddle a cell the sweep
 * then fails to paint, so the bound that matters is set by the grid, not by the
 * fire. An adaptive target would be free to drift above it.
 *
 * Removal never takes the ring below {@link MIN_RING_VERTICES}, so a small ring
 * cannot collapse to a degenerate line or point.
 */
export const MIN_RING_VERTICES = 8;

export function densityControl(ring: Ring, minLen: number, maxLen: number): void {
  const { xs, ys } = ring;
  const n = xs.length;
  if (n < 3) return;

  const outX: number[] = [];
  const outY: number[] = [];
  // Walk the ring once, carrying the last vertex actually kept. A vertex closer
  // than `minLen` to it is dropped; a gap longer than `maxLen` is filled with
  // evenly spaced intermediates. One pass, and the result is a pure function of
  // the input order — which is what D9's determinism rule needs.
  let lastX = xs[0];
  let lastY = ys[0];
  outX.push(lastX);
  outY.push(lastY);

  for (let i = 1; i <= n; i++) {
    // i === n closes the ring back onto vertex 0, which is already in `out`.
    const closing = i === n;
    const px = closing ? xs[0] : xs[i];
    const py = closing ? ys[0] : ys[i];
    const dx = px - lastX;
    const dy = py - lastY;
    const len = Math.hypot(dx, dy);

    if (len < minLen && !closing) {
      // Too close to the last kept vertex — drop it, unless doing so would take
      // the ring below the floor. `n - i` is how many originals are still to
      // come, so this is the count the ring would end up with.
      if (outX.length + (n - i) > MIN_RING_VERTICES) continue;
    }
    if (len > maxLen) {
      const pieces = Math.ceil(len / maxLen);
      for (let k = 1; k < pieces; k++) {
        outX.push(lastX + (dx * k) / pieces);
        outY.push(lastY + (dy * k) / pieces);
      }
    }
    if (!closing) {
      outX.push(px);
      outY.push(py);
    }
    lastX = px;
    lastY = py;
  }

  ring.xs = outX;
  ring.ys = outY;
}

/**
 * Whether `(px, py)` is inside the ring, by crossing count — FARSITE's
 * `Rasterize::Overlap`. Points exactly on an edge are not guaranteed either way,
 * which is fine for every caller here (the raster is painted from the swept
 * band, not from a fill).
 */
export function pointInRing(ring: Ring, px: number, py: number): boolean {
  const { xs, ys } = ring;
  const n = xs.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ys[i];
    const yj = ys[j];
    if (yi > py !== yj > py) {
      const t = (py - yi) / (yj - yi);
      if (px < xs[i] + t * (xs[j] - xs[i])) inside = !inside;
    }
  }
  return inside;
}

/**
 * Whether two segments properly cross, and where — FARSITE's
 * `StandardizePolygon::Cross`. Collinear overlap counts as no crossing (it has
 * no single intersection point to split a perimeter at), and an endpoint touch
 * is included, because a front that has just grazed itself has to be caught
 * before the next step turns the graze into a loop.
 *
 * Used by the crossover removal of Stage 3; kept here with the rest of the
 * polygon geometry so all of it is testable without world state.
 */
export interface Crossing {
  x: number;
  y: number;
}

export function segmentCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
  out: Crossing,
): boolean {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return false; // parallel or collinear
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return false;
  out.x = ax + t * rx;
  out.y = ay + t * ry;
  return true;
}

/**
 * Visit every cell the segment `(x0, y0) → (x1, y1)` passes through, in order,
 * including both endpoints' cells — an Amanatides–Woo voxel traversal in cell
 * units.
 *
 * This is what paints the front into the raster, so it must not *skip*: a
 * skipped cell is a hole in the burn. It is deliberately not a Bresenham line —
 * Bresenham picks one cell per column and would step diagonally past a shared
 * corner, leaving exactly such a hole.
 *
 * `visit` returning `false` stops the walk early.
 */
export function traverseSegment(
  x0: number, y0: number, x1: number, y1: number,
  visit: (cx: number, cy: number) => boolean | void,
): void {
  let ix = Math.floor(x0);
  let iy = Math.floor(y0);
  const ex = Math.floor(x1);
  const ey = Math.floor(y1);
  if (visit(ix, iy) === false) return;
  if (ix === ex && iy === ey) return;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx > 0 ? (ix + 1 - x0) / dx : dx < 0 ? (ix - x0) / dx : Infinity;
  let tMaxY = dy > 0 ? (iy + 1 - y0) / dy : dy < 0 ? (iy - y0) / dy : Infinity;

  // A hard iteration cap, not an optimisation: with denormal deltas the exit
  // test can be reached only after a rounding error, and a fire model that hangs
  // is worse than one that paints one cell short.
  const limit = Math.abs(ex - ix) + Math.abs(ey - iy) + 2;
  for (let n = 0; n < limit; n++) {
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) return;
      ix += stepX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > 1) return;
      iy += stepY;
      tMaxY += tDeltaY;
    }
    if (visit(ix, iy) === false) return;
    if (ix === ex && iy === ey) return;
  }
}

/**
 * A regular n-gon of radius `r` about `(cx, cy)`, wound **counter-clockwise as
 * seen on screen** — the winding {@link signedArea2} and `richards.ts` require,
 * and how every perimeter in this engine is born.
 *
 * On screen y grows downward, so stepping the angle *backwards* through the
 * usual parametrisation is what reads as counter-clockwise to a viewer.
 */
export function seedRing(cx: number, cy: number, r: number, vertices: number): Ring {
  const xs: number[] = new Array(vertices);
  const ys: number[] = new Array(vertices);
  for (let k = 0; k < vertices; k++) {
    const a = (2 * Math.PI * k) / vertices;
    xs[k] = cx + r * Math.cos(a);
    ys[k] = cy - r * Math.sin(a);
  }
  return { xs, ys };
}
