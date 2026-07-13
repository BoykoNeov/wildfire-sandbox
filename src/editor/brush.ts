import type { LayerData } from '../core/grid';

/**
 * Pure brush geometry for the terrain editor (Phase-2 step 5). Walks the cells of
 * a filled disc — or a stroke swept between two disc centres — and either invokes
 * a callback per cell or writes a value into a layer's typed array. No DOM, no
 * world state: this is the testable core; the DOM/pointer wiring in
 * `terrainEditor.ts` stays thin on top of it.
 *
 * NOTE on Uint8 layers: a `Uint8Array` write **wraps mod 256**, it does not
 * saturate. Callers must constrain `value` to the layer's real range (fuel 0–3,
 * moisture/canopy 0–255) *before* calling — the brush does not clamp values.
 */

/**
 * Visit every in-bounds cell of a stroke: a series of filled discs of `radius`
 * (in cells; 0 = a single cell) swept from (x0,y0) to (x1,y1), one step per cell
 * along the longer axis so a fast pointer drag leaves no gaps. Out-of-bounds
 * cells are skipped, so the caller need not clamp the endpoints' discs — though
 * the centres themselves should be in bounds for the sweep to track the pointer.
 * Overlapping discs revisit shared cells; `fn` must tolerate being called twice
 * for the same cell (paint is idempotent; ignition is effectively so).
 */
export function forEachStrokeCell(
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  fn: (x: number, y: number, index: number) => void,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const r2 = radius * radius;
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const cx = Math.round(x0 + dx * t);
    const cy = Math.round(y0 + dy * t);
    const xa = Math.max(0, cx - radius);
    const xb = Math.min(width - 1, cx + radius);
    const ya = Math.max(0, cy - radius);
    const yb = Math.min(height - 1, cy + radius);
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const ddx = x - cx;
        const ddy = y - cy;
        if (ddx * ddx + ddy * ddy <= r2) fn(x, y, y * width + x);
      }
    }
  }
}

/** Paint a stroke of `value` into a layer (see {@link forEachStrokeCell}). */
export function paintStroke(
  data: LayerData,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  value: number,
): void {
  forEachStrokeCell(width, height, x0, y0, x1, y1, radius, (_x, _y, i) => {
    data[i] = value;
  });
}

/** Paint a single filled disc of `value` centred on (cx, cy). */
export function paintDisc(
  data: LayerData,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  value: number,
): void {
  paintStroke(data, width, height, cx, cy, cx, cy, radius, value);
}
