import { describe, expect, it } from 'vitest';
import { forEachStrokeCell, paintDisc, paintStroke } from '../src/editor/brush';

const W = 16;
const H = 16;

function countSet(data: Uint8Array): number {
  let n = 0;
  for (const v of data) if (v !== 0) n++;
  return n;
}

describe('paintDisc', () => {
  it('radius 0 paints exactly the centre cell', () => {
    const data = new Uint8Array(W * H);
    paintDisc(data, W, H, 8, 8, 0, 5);
    expect(countSet(data)).toBe(1);
    expect(data[8 * W + 8]).toBe(5);
  });

  it('paints a symmetric filled disc (radius 2 → the ⊕ shape of 13 cells)', () => {
    // Cells within Euclidean radius 2 of the centre: a 13-cell plus/diamond+.
    const data = new Uint8Array(W * H);
    paintDisc(data, W, H, 8, 8, 2, 1);
    expect(countSet(data)).toBe(13);
    // Corners of the bounding box are outside radius 2 (dist √8 > 2) → untouched.
    expect(data[(8 - 2) * W + (8 - 2)]).toBe(0);
    // The four cardinal extremes at distance exactly 2 are inside.
    expect(data[(8 - 2) * W + 8]).toBe(1);
    expect(data[(8 + 2) * W + 8]).toBe(1);
  });

  it('clips to bounds when centred in a corner (no out-of-range writes)', () => {
    const data = new Uint8Array(W * H);
    paintDisc(data, W, H, 0, 0, 3, 7);
    // Only the in-bounds quarter of the disc is written; nothing throws.
    expect(data[0]).toBe(7);
    expect(countSet(data)).toBeGreaterThan(0);
    expect(countSet(data)).toBeLessThan(13); // far less than a full r=3 disc
  });

  it('writes into a Float32 layer (elevation) unchanged', () => {
    const data = new Float32Array(W * H);
    paintDisc(data, W, H, 8, 8, 0, 847.5);
    expect(data[8 * W + 8]).toBe(847.5);
  });
});

describe('paintStroke', () => {
  it('fills a contiguous cardinal line with no gaps (radius 0)', () => {
    const data = new Uint8Array(W * H);
    paintStroke(data, W, H, 2, 5, 12, 5, 0, 1);
    for (let x = 2; x <= 12; x++) expect(data[5 * W + x]).toBe(1);
    expect(countSet(data)).toBe(11);
  });

  it('leaves no gaps on a steep diagonal drag (radius 0)', () => {
    const data = new Uint8Array(W * H);
    paintStroke(data, W, H, 1, 1, 10, 3, 0, 1);
    // Every step along the longer (x) axis is sampled → 10 distinct cells, and
    // each row between the endpoints is touched (front stays 8-connected).
    expect(countSet(data)).toBe(10);
  });
});

describe('forEachStrokeCell', () => {
  it('reports (x, y, index) consistent with row-major layout', () => {
    const seen: Array<[number, number, number]> = [];
    forEachStrokeCell(W, H, 4, 4, 4, 4, 0, (x, y, i) => seen.push([x, y, i]));
    expect(seen).toEqual([[4, 4, 4 * W + 4]]);
  });
});
