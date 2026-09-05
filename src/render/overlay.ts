import type { WorldState } from '../core/world';
import type { GroundCrew } from '../sim/groundCrew';
import type { Engine } from '../sim/engine';
import type { Aircraft } from '../sim/aircraft';

/**
 * Screen-resolution overlays. Everything here draws onto the separate overlay
 * canvas laid over the pixel-art view (sized to the CSS box × devicePixelRatio),
 * so arrows, unit glyphs, labels and cursors stay crisp at any zoom instead of
 * being 1–2 blurry cells wide. All of it is a pure **read** of world state and
 * agent getters (renderer discipline — never drives the sim, never touches the
 * RNG). Coordinates: screen y grows south, so a vector with +v points down.
 *
 * `Viewport` carries the mapping from cells to overlay pixels: `sx`/`sy` are
 * pixels per cell, `dpr` the device pixel ratio so line widths and fonts can be
 * specified in CSS pixels.
 */
export interface Viewport {
  width: number; // overlay backing-store width (px)
  height: number;
  sx: number; // px per cell, x
  sy: number; // px per cell, y
  dpr: number;
}

export function makeViewport(world: WorldState, width: number, height: number, dpr: number): Viewport {
  return { width, height, sx: width / world.width, sy: height / world.height, dpr };
}

/**
 * Wind overlay (the Phase-3 wind plan's deferred "arrows / streamlines").
 * Arrows sit on a lattice every `spacingCells`; length scales with speed (capped
 * so a gale stays legible), and each is shaded by speed so gust structure reads
 * at a glance.
 */
export function drawWindOverlay(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  vp: Viewport,
  spacingCells = 16,
): void {
  const { width, height, layers } = world;
  const windU = layers.windU.data;
  const windV = layers.windV.data;
  const { sx, sy } = vp;
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
      const head = Math.min(7 * vp.dpr, len * 0.35);

      const a = 0.45 + 0.45 * Math.min(1, speed / 12);
      ctx.strokeStyle = `rgba(232, 242, 255, ${a.toFixed(3)})`;
      ctx.lineWidth = 1.5 * vp.dpr;
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

// ───────────────────────── unit markers ─────────────────────────

export interface UnitRoster {
  crew?: GroundCrew | null;
  engine?: Engine | null;
  aircraft?: Aircraft | null;
}

/** Unit colours: crew blue, engine green, tanker rust — matched to the HUD text. */
const CREW_RGB = '80, 170, 255';
const ENGINE_RGB = '90, 230, 150';
const TANKER_RGB = '235, 120, 85';
const IDLE_RGB = '150, 150, 165';

/**
 * Stamp each wired unit's position, current target and planned work on the
 * overlay: a glyph per unit type (crew ● / engine ■ / tanker ▲ heading toward
 * its target), a dashed lead line to the target, the crew's queued line as a
 * dotted path, the tanker's drop footprint as a square outline, and the
 * engine's tank as a small bar. Dimmed grey while a unit has broken off to
 * reload / refill.
 */
export function drawUnitMarkers(ctx: CanvasRenderingContext2D, units: UnitRoster, vp: Viewport): void {
  const { sx, sy, dpr } = vp;
  const cx = (x: number): number => (x + 0.5) * sx;
  const cy = (y: number): number => (y + 0.5) * sy;
  const r = Math.max(4 * dpr, Math.min(sx, sy) * 1.4); // glyph radius

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const lead = (x0: number, y0: number, x1: number, y1: number, rgb: string): void => {
    ctx.strokeStyle = `rgba(${rgb}, 0.75)`;
    ctx.lineWidth = 1.2 * dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(cx(x0), cy(y0));
    ctx.lineTo(cx(x1), cy(y1));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const ring = (x: number, y: number, rad: number, rgb: string): void => {
    ctx.strokeStyle = `rgba(${rgb}, 0.9)`;
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.arc(cx(x), cy(y), rad, 0, Math.PI * 2);
    ctx.stroke();
  };
  const label = (x: number, y: number, text: string, rgb: string): void => {
    const px = cx(x);
    const py = cy(y) + r + 2 * dpr;
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(15, 12, 10, 0.85)';
    ctx.strokeText(text, px, py);
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.fillText(text, px, py);
  };
  const halo = (x: number, y: number): void => {
    ctx.fillStyle = 'rgba(15, 12, 10, 0.55)';
    ctx.beginPath();
    ctx.arc(cx(x), cy(y), r + 1.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  };

  // --- hand crew: a disc; queued line as dots; head order ringed -------------
  const crew = units.crew;
  if (crew) {
    const orders = crew.pendingOrders;
    if (orders.length > 0) {
      ctx.fillStyle = `rgba(${CREW_RGB}, 0.55)`;
      const dot = Math.max(1.2 * dpr, Math.min(sx, sy) * 0.3);
      for (let k = 1; k < orders.length; k++) {
        const o = orders[k];
        ctx.beginPath();
        ctx.arc(cx(o.x), cy(o.y), dot, 0, Math.PI * 2);
        ctx.fill();
      }
      const head = orders[0];
      lead(crew.cellX, crew.cellY, head.x, head.y, CREW_RGB);
      ring(head.x, head.y, r * 0.7, CREW_RGB);
    }
    halo(crew.cellX, crew.cellY);
    ctx.fillStyle = `rgb(${CREW_RGB})`;
    ctx.beginPath();
    ctx.arc(cx(crew.cellX), cy(crew.cellY), r * 0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#eaf6ff';
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();
    const task = crew.currentTask;
    label(crew.cellX, crew.cellY, task ? `CREW · ${TASK_LABEL[task]}` : 'CREW', CREW_RGB);
  }

  // --- engine: a square with a water bar; grey while refilling ----------------
  const eng = units.engine;
  if (eng) {
    const rgb = eng.isRefilling ? IDLE_RGB : ENGINE_RGB;
    const t = eng.targetCell;
    if (t) {
      lead(eng.cellX, eng.cellY, t.x, t.y, rgb);
      ring(t.x, t.y, r * 0.7, rgb);
    }
    halo(eng.cellX, eng.cellY);
    const s = r * 0.7;
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.fillRect(cx(eng.cellX) - s, cy(eng.cellY) - s, 2 * s, 2 * s);
    ctx.strokeStyle = '#eafff2';
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeRect(cx(eng.cellX) - s, cy(eng.cellY) - s, 2 * s, 2 * s);
    // Tank bar just above the glyph.
    const bw = 2 * r;
    const bh = 3 * dpr;
    const bx = cx(eng.cellX) - r;
    const by = cy(eng.cellY) - r - bh - 3 * dpr;
    ctx.fillStyle = 'rgba(15, 12, 10, 0.75)';
    ctx.fillRect(bx - dpr, by - dpr, bw + 2 * dpr, bh + 2 * dpr);
    ctx.fillStyle = eng.waterFraction > 0.25 ? '#6fd3ff' : '#ff9a5c';
    ctx.fillRect(bx, by, bw * Math.max(0, Math.min(1, eng.waterFraction)), bh);
    label(eng.cellX, eng.cellY, eng.isRefilling ? 'ENGINE · refilling' : eng.isIdle ? 'ENGINE' : 'ENGINE · attack', rgb);
  }

  // --- air tanker: a triangle pointing at its heading; drop footprint outlined --
  const air = units.aircraft;
  if (air) {
    const rgb = air.isReturning ? IDLE_RGB : TANKER_RGB;
    const t = air.targetCell;
    let hx = 0;
    let hy = -1; // default heading: north
    if (t) {
      const dx = t.x - air.cellX;
      const dy = t.y - air.cellY;
      const d = Math.hypot(dx, dy);
      if (d > 0.5) {
        hx = dx / d;
        hy = dy / d;
      }
      lead(air.cellX, air.cellY, t.x, t.y, rgb);
      if (!air.isReturning) {
        // Drop footprint: the (2r+1)² swath the load will cover.
        const fr = air.footprintRadius;
        ctx.strokeStyle = `rgba(${rgb}, 0.9)`;
        ctx.lineWidth = 1.2 * dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.strokeRect((t.x - fr) * sx, (t.y - fr) * sy, (2 * fr + 1) * sx, (2 * fr + 1) * sy);
        ctx.setLineDash([]);
      }
    }
    halo(air.cellX, air.cellY);
    const px = cx(air.cellX);
    const py = cy(air.cellY);
    const R = r * 0.95;
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath();
    ctx.moveTo(px + hx * R, py + hy * R);
    ctx.lineTo(px - hx * R * 0.7 - hy * R * 0.65, py - hy * R * 0.7 + hx * R * 0.65);
    ctx.lineTo(px - hx * R * 0.7 + hy * R * 0.65, py - hy * R * 0.7 - hx * R * 0.65);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffe8e0';
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();
    const load = air.pendingLoad;
    const text = air.isReturning ? 'TANKER · reloading' : load ? `TANKER · ${load}` : 'TANKER';
    label(air.cellX, air.cellY, text, rgb);
  }

  ctx.restore();
}

const TASK_LABEL: Record<string, string> = {
  'cut-line': 'cutting line',
  backburn: 'backburn',
  'direct-attack': 'direct attack',
};

// ───────────────────────── cursor ─────────────────────────

/**
 * What the pointer will do where it hovers: a footprint outline of `radius`
 * cells around the hovered cell (0 = the single cell), tinted by the armed tool.
 * `label` is drawn beside it (e.g. the readout of the hovered cell).
 */
export function drawBrushCursor(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  cellX: number,
  cellY: number,
  radius: number,
  rgb: string,
  square: boolean,
): void {
  const { sx, sy, dpr } = vp;
  ctx.save();
  ctx.strokeStyle = `rgba(${rgb}, 0.9)`;
  ctx.lineWidth = 1.2 * dpr;
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  if (square) {
    ctx.strokeRect((cellX - radius) * sx, (cellY - radius) * sy, (2 * radius + 1) * sx, (2 * radius + 1) * sy);
  } else {
    ctx.beginPath();
    ctx.arc((cellX + 0.5) * sx, (cellY + 0.5) * sy, (radius + 0.5) * Math.min(sx, sy), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // Centre tick so a 1-cell footprint is still findable.
  ctx.fillStyle = `rgba(${rgb}, 0.9)`;
  ctx.fillRect((cellX + 0.5) * sx - dpr, (cellY + 0.5) * sy - dpr, 2 * dpr, 2 * dpr);
  ctx.restore();
}
