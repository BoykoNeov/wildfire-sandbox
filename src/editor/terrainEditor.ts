import type { WorldState } from '../core/world';
import { byteToFraction } from '../core/moisture';
import { Fuel } from '../sim/basicFuelModel';
import { ignite } from '../gen/terrain';
import { forEachStrokeCell, paintStroke } from './brush';

/**
 * Phase-2 step 5 — the terrain editor. A brush-paint tool over the world's data
 * layers, wired only in the browser entry (`main.ts`); the headless sim and the
 * `renderFrame` tool never see it. It **writes layer bytes only** (plus the
 * `fire` layer via the shared `ignite()` helper) — it never calls a system and
 * never touches the RNG, so the architecture invariants and determinism hold.
 *
 * The pure disc/stroke geometry lives in `brush.ts` (unit-tested); this file is
 * the thin DOM + pointer shell: a floating toolbar, pointer-drag painting, and a
 * live cell readout. It owns the `paused` flag (a pure UI concern) which the
 * frame loop reads to decide whether to advance the sim.
 *
 * Scope: paints elevation / fuel / moisture / canopy (the step-5 spec) plus an
 * Ignite tool (a small sandbox convenience — you have to start fires somewhere).
 * There is deliberately **no extinguish/suppression tool**: that would need to
 * clear the fire model's private spread-progress accumulator (a cell set back to
 * Unburned with progress ≥ 1 re-ignites instantly), which is real coupling to a
 * stateful system — suppression is Phase 4, not a paint tool.
 */

type PaintTool = 'elevation' | 'fuel' | 'moisture' | 'canopy';
type Tool = PaintTool | 'ignite';

const TOOLS: ReadonlyArray<{ id: Tool; label: string }> = [
  { id: 'elevation', label: 'Elevation' },
  { id: 'fuel', label: 'Fuel' },
  { id: 'moisture', label: 'Moisture' },
  { id: 'canopy', label: 'Canopy' },
  { id: 'ignite', label: 'Ignite' },
];

const FUEL_OPTIONS: ReadonlyArray<{ id: number; label: string }> = [
  { id: Fuel.Nonburnable, label: 'Nonburnable' },
  { id: Fuel.Grass, label: 'Grass' },
  { id: Fuel.Brush, label: 'Brush' },
  { id: Fuel.Timber, label: 'Timber' },
];

const FUEL_NAME: Record<number, string> = {
  [Fuel.Nonburnable]: 'nonburnable',
  [Fuel.Grass]: 'grass',
  [Fuel.Brush]: 'brush',
  [Fuel.Timber]: 'timber',
};

/** Values are constrained here (at the control) so the brush never wraps a Uint8. */
interface ToolValues {
  elevation: number; // metres, 0..1000
  fuel: number; // Fuel id 0..3
  moisture: number; // byte 0..255
  canopy: number; // byte 0..255
}

export class TerrainEditor {
  private tool: Tool = 'fuel';
  private readonly values: ToolValues = { elevation: 500, fuel: Fuel.Grass, moisture: 30, canopy: 100 };
  private radius = 3;
  private _paused = false;

  private painting = false;
  private last: { x: number; y: number } | null = null;

  // Controls whose visibility toggles with the active tool.
  private readonly valueRows = new Map<PaintTool, HTMLElement>();
  private readout!: HTMLElement;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: WorldState,
  ) {
    this.buildToolbar();
    this.updateValueVisibility();

    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
  }

  /** The frame loop reads this to decide whether to step the sim. */
  get paused(): boolean {
    return this._paused;
  }

  // --- pointer → cells ------------------------------------------------------

  /** Map a pointer event to an in-bounds cell (the canvas is CSS-scaled up). */
  private cellAt(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const { width, height } = this.world;
    let x = Math.floor(((e.clientX - rect.left) / rect.width) * width);
    let y = Math.floor(((e.clientY - rect.top) / rect.height) * height);
    x = x < 0 ? 0 : x >= width ? width - 1 : x;
    y = y < 0 ? 0 : y >= height ? height - 1 : y;
    return { x, y };
  }

  private onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.painting = true;
    this.canvas.setPointerCapture(e.pointerId);
    const c = this.cellAt(e);
    this.applyStroke(c, c);
    this.last = c;
    this.updateReadout(c);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const c = this.cellAt(e);
    this.updateReadout(c);
    if (!this.painting) return;
    this.applyStroke(this.last ?? c, c);
    this.last = c;
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.painting = false;
    this.last = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private onPointerLeave = (): void => {
    this.readout.textContent = '—';
  };

  // --- applying the tool ----------------------------------------------------

  private applyStroke(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const { width, height, layers } = this.world;
    if (this.tool === 'ignite') {
      const fuel = layers.fuel.data;
      forEachStrokeCell(width, height, from.x, from.y, to.x, to.y, this.radius, (x, y, i) => {
        // Only ignite burnable cells; a Burning nonburnable cell has no Rothermel
        // bed, so the model would flash it straight to Burned (a black speck).
        if (fuel[i] !== Fuel.Nonburnable) ignite(this.world, x, y);
      });
      return;
    }
    const layer = layers[this.tool];
    paintStroke(layer.data, width, height, from.x, from.y, to.x, to.y, this.radius, this.values[this.tool]);
  }

  // --- readout --------------------------------------------------------------

  private updateReadout(c: { x: number; y: number }): void {
    const { layers } = this.world;
    const i = layers.fuel.index(c.x, c.y);
    const elev = Math.round(layers.elevation.data[i]);
    const fuelName = FUEL_NAME[layers.fuel.data[i]] ?? '?';
    const moistPct = Math.round(byteToFraction(layers.moisture.data[i]) * 100);
    const canopy = layers.canopy.data[i];
    this.readout.textContent = `(${c.x}, ${c.y})  ${elev} m · ${fuelName} · ${moistPct}% moist · canopy ${canopy}`;
  }

  // --- toolbar (DOM) --------------------------------------------------------

  private buildToolbar(): void {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      top: '12px',
      left: '12px',
      padding: '10px 12px',
      font: '12px system-ui, sans-serif',
      color: '#e8e2dc',
      background: '#2a2320e6',
      border: '1px solid #4a3f38',
      borderRadius: '8px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      userSelect: 'none',
      zIndex: '10',
      minWidth: '200px',
    } satisfies Partial<CSSStyleDeclaration>);

    panel.appendChild(this.buildToolRow());
    for (const t of ['elevation', 'moisture', 'canopy'] as const) {
      panel.appendChild(this.buildSliderRow(t));
    }
    panel.appendChild(this.buildFuelRow());
    panel.appendChild(this.buildBrushRow());
    panel.appendChild(this.buildPauseRow());

    this.readout = document.createElement('div');
    Object.assign(this.readout.style, {
      marginTop: '2px',
      paddingTop: '6px',
      borderTop: '1px solid #4a3f38',
      color: '#b8ada4',
      fontVariantNumeric: 'tabular-nums',
    });
    this.readout.textContent = '—';
    panel.appendChild(this.readout);

    document.body.appendChild(panel);
  }

  private buildToolRow(): HTMLElement {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    for (const t of TOOLS) {
      const btn = document.createElement('button');
      btn.textContent = t.label;
      Object.assign(btn.style, buttonStyle);
      const paint = (): void => {
        this.tool = t.id;
        this.updateValueVisibility();
        for (const child of Array.from(row.children)) {
          (child as HTMLElement).style.background = child === btn ? '#c8642c' : '#3a322c';
        }
      };
      btn.addEventListener('click', paint);
      if (t.id === this.tool) btn.style.background = '#c8642c';
      row.appendChild(btn);
    }
    return row;
  }

  private buildSliderRow(tool: 'elevation' | 'moisture' | 'canopy'): HTMLElement {
    const max = tool === 'elevation' ? 1000 : 255;
    const { row, input, value } = labeledSlider(TOOLS.find((t) => t.id === tool)!.label, 0, max, this.values[tool]);
    const fmt = (v: number): string =>
      tool === 'elevation' ? `${v} m` : tool === 'moisture' ? `${Math.round((v / 255) * 100)}%` : `${v}`;
    value.textContent = fmt(this.values[tool]);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      this.values[tool] = v;
      value.textContent = fmt(v);
    });
    this.valueRows.set(tool, row);
    return row;
  }

  private buildFuelRow(): HTMLElement {
    const row = document.createElement('label');
    Object.assign(row.style, rowStyle);
    row.append(labelSpan('Fuel'));
    const select = document.createElement('select');
    Object.assign(select.style, { flex: '1', background: '#3a322c', color: '#e8e2dc', border: '1px solid #4a3f38', borderRadius: '4px' });
    for (const o of FUEL_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(o.id);
      opt.textContent = o.label;
      if (o.id === this.values.fuel) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      this.values.fuel = Number(select.value);
    });
    row.appendChild(select);
    this.valueRows.set('fuel', row);
    return row;
  }

  private buildBrushRow(): HTMLElement {
    const { row, input, value } = labeledSlider('Brush', 0, 20, this.radius);
    value.textContent = `${this.radius}`;
    input.addEventListener('input', () => {
      this.radius = Number(input.value);
      value.textContent = `${this.radius}`;
    });
    return row;
  }

  private buildPauseRow(): HTMLElement {
    const btn = document.createElement('button');
    Object.assign(btn.style, { ...buttonStyle, alignSelf: 'flex-start' });
    const label = (): string => (this._paused ? '▶ Resume sim' : '⏸ Pause sim');
    btn.textContent = label();
    btn.addEventListener('click', () => {
      this._paused = !this._paused;
      btn.textContent = label();
      btn.style.background = this._paused ? '#c8642c' : '#3a322c';
    });
    const row = document.createElement('div');
    row.appendChild(btn);
    return row;
  }

  /** Show only the value control relevant to the active tool (Ignite has none). */
  private updateValueVisibility(): void {
    for (const [tool, row] of this.valueRows) {
      row.style.display = tool === this.tool ? '' : 'none';
    }
  }
}

// --- tiny DOM helpers -------------------------------------------------------

const buttonStyle: Partial<CSSStyleDeclaration> = {
  padding: '4px 8px',
  font: 'inherit',
  color: '#e8e2dc',
  background: '#3a322c',
  border: '1px solid #4a3f38',
  borderRadius: '4px',
  cursor: 'pointer',
};

const rowStyle: Partial<CSSStyleDeclaration> = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

function labelSpan(text: string): HTMLElement {
  const span = document.createElement('span');
  span.textContent = text;
  Object.assign(span.style, { width: '64px', color: '#b8ada4' });
  return span;
}

function labeledSlider(
  label: string,
  min: number,
  max: number,
  initial: number,
): { row: HTMLElement; input: HTMLInputElement; value: HTMLElement } {
  const row = document.createElement('label');
  Object.assign(row.style, rowStyle);
  row.append(labelSpan(label));
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(initial);
  input.style.flex = '1';
  const value = document.createElement('span');
  Object.assign(value.style, { width: '48px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' });
  row.append(input, value);
  return { row, input, value };
}
