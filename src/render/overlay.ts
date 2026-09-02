import type { WorldState } from '../core/world';

/**
 * Wind overlay (the Phase-3 wind plan's deferred "arrows / streamlines"). Draws
 * onto a separate, screen-resolution canvas laid over the pixel-art view, so the
 * arrows stay crisp at any zoom. A pure **read** of `windU/windV` (renderer
 * discipline — never drives the sim, never touches the RNG).
 *
 * Arrows sit on a lattice every `spacingCells`; length scales with speed (capped
 * so a gale stays legible), and each is shaded by speed so gust structure reads
 * at a glance. Coordinates: screen y grows south, so a vector with +v points down.
 */
export function drawWindOverlay(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  cssWidth: number,
  cssHeight: number,
  spacingCells = 16,
): void {
  const { width, height, layers } = world;
  const windU = layers.windU.data;
  const windV = layers.windV.data;
  const sx = cssWidth / width; // css px per cell
  const sy = cssHeight / height;
  const cellPx = Math.min(sx, sy);
  const maxLen = spacingCells * cellPx * 0.8;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let cy = spacingCells >> 1; cy < height; cy += spacingCells) {
    for (let cx = spacingCells >> 1; cx < width; cx += spacingCells) {
      const i = cy * width + cx;
      const u = windU[i];
      const v = windV[i];
      const speed = Math.hypot(u, v);
      if (speed < 0.05) continue;
      // 12 m/s fills the lattice cell; slower winds draw shorter arrows.
      const len = Math.min(maxLen, (speed / 12) * maxLen);
      const ux = u / speed;
      const uy = v / speed;
      const x0 = (cx + 0.5) * sx - ux * len * 0.5;
      const y0 = (cy + 0.5) * sy - uy * len * 0.5;
      const x1 = x0 + ux * len;
      const y1 = y0 + uy * len;
      const head = Math.min(7, len * 0.35);

      const a = 0.45 + 0.45 * Math.min(1, speed / 12);
      ctx.strokeStyle = `rgba(232, 242, 255, ${a.toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      // Arrow head.
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}
