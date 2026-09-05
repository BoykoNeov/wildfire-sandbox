import type { WorldState } from '../core/world';
import type { GroundCrew } from '../sim/groundCrew';
import type { Engine } from '../sim/engine';
import type { Aircraft } from '../sim/aircraft';
import { forEachStrokeCell } from './brush';
import { drawUnitMarkers, type Viewport } from '../render/overlay';

/**
 * Phase-4 4a **player command shell** (`docs/plans/phase-4-firefighting.md`
 * §"player command layer"). A browser-only DOM + pointer layer, wired only in
 * `main.ts`, that turns a click/drag into an *order* for a unit (assign task →
 * target cell). It is modelled on {@link TerrainEditor}: it writes nothing into
 * world state itself — it only enqueues orders on the units, whose deterministic
 * `step()` does the actual layer writes. So it is **non-deterministic and lives
 * outside the determinism test**, exactly as the editor does.
 *
 * **Every unit is optional, and the toolbar offers exactly the tools whose unit is
 * wired.** A scenario roster is free to omit any of crew / engine / aircraft (see
 * `ScenarioAgents`); the panel then simply has fewer buttons. This is deliberate:
 * an armed tool with no unit behind it would swallow clicks and do nothing, which
 * is the silent failure this gating exists to prevent. `main.ts` builds the shell
 * whenever *any* unit is wired, so no declared unit can end up uncommandable.
 *
 * The 4a crew tools — **Cut line**, **Backburn**, **Direct attack** — execute FIFO:
 * a drag with the Line tool enqueues one `cut-line` order per cell along the stroke,
 * and the crew travels the line cutting each cell in turn — you watch the tan
 * scratch grow. Backburn and Direct attack are single-click orders. Direct attack is
 * *held* (the crew re-wets its footprint each tick) until Stand down or another
 * order replaces it.
 *
 * The 4b **Engine** tool is a single-click held station too, but the engine draws a
 * wider, wetter knockdown from a FINITE tank and auto-refills when dry. A small
 * gauge in the panel reads its remaining water.
 *
 * The 4c **Water drop** / **Retardant drop** tools are single-click *sorties*: the
 * tanker flies out, lays one wide drop on the clicked cell, and returns to base to
 * reload. Water is a big temporary knockdown; retardant is a persistent rust-red
 * pre-treatment. A drop on a flaming timber crown is near-useless (the crown-fire
 * falloff) — pre-treat unburned fuel *ahead* of the front instead.
 *
 * **Coexistence with the terrain editor.** Both attach to the same canvas. When a
 * suppression tool is armed (anything but "Off") this shell handles the pointer in
 * the *capture* phase and stops it there, so the editor's brush does not also fire;
 * "Off" hands the pointer straight through to the editor. This keeps terrain
 * authoring and fire command on one canvas without a modal split.
 */

type CmdTool = 'off' | 'line' | 'backburn' | 'direct' | 'engine' | 'water' | 'retardant';

/** Which wired unit a tool needs to do anything; `null` = always available. */
type ToolNeeds = 'crew' | 'engine' | 'aircraft' | null;

/**
 * Every tool declares the unit it commands, so {@link SuppressionCommand.buildToolbar}
 * can offer only the ones that are actually wired. `off` needs nothing and is
 * therefore always present — without it there would be no way to hand the pointer
 * back to the terrain editor.
 */
const TOOLS: ReadonlyArray<{ id: CmdTool; label: string; needs: ToolNeeds }> = [
  { id: 'off', label: 'Off (terrain)', needs: null },
  { id: 'line', label: 'Cut line', needs: 'crew' },
  { id: 'backburn', label: 'Backburn', needs: 'crew' },
  { id: 'direct', label: 'Direct attack', needs: 'crew' },
  { id: 'engine', label: 'Engine attack', needs: 'engine' },
  { id: 'water', label: 'Water drop', needs: 'aircraft' },
  { id: 'retardant', label: 'Retardant drop', needs: 'aircraft' },
];

/** Cursor tint per armed tool (see `overlay.ts` colours: crew blue / engine green / tanker rust). */
const TOOL_RGB: Record<CmdTool, string> = {
  off: '255, 255, 255',
  line: '80, 170, 255',
  backburn: '255, 160, 60',
  direct: '80, 170, 255',
  engine: '90, 230, 150',
  water: '110, 200, 255',
  retardant: '235, 120, 85',
};

export class SuppressionCommand {
  private tool: CmdTool = 'off';

  private dragging = false;
  private last: { x: number; y: number } | null = null;
  /** Cells already ordered this stroke — a drag revisits cells; don't flood the queue. */
  private readonly strokeSeen = new Set<number>();

  /** Gauge element updated each frame with the engine's remaining water. */
  private waterGauge: HTMLElement | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: WorldState,
    private readonly crew?: GroundCrew,
    private readonly engine?: Engine,
    private readonly aircraft?: Aircraft,
  ) {
    this.buildToolbar();
    // Capture phase so an armed suppression tool intercepts the pointer before the
    // terrain editor's (bubble-phase) brush handler runs.
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointermove', this.onPointerMove, true);
    canvas.addEventListener('pointerup', this.onPointerUp, true);
    canvas.addEventListener('pointercancel', this.onPointerUp, true);
  }

  /** Whether an armed tool is intercepting pointer input (else the editor gets it). */
  get active(): boolean {
    return this.tool !== 'off';
  }

  /** The armed tool's footprint radius [cells] and cursor tint, for the overlay cursor. */
  get cursor(): { radius: number; rgb: string; square: boolean } {
    switch (this.tool) {
      case 'direct':
        return { radius: 1, rgb: TOOL_RGB.direct, square: true }; // crew knockdown 3×3
      case 'engine':
        return { radius: 2, rgb: TOOL_RGB.engine, square: true }; // engine knockdown 5×5
      case 'water':
      case 'retardant':
        return { radius: this.aircraft?.footprintRadius ?? 3, rgb: TOOL_RGB[this.tool], square: true };
      default:
        return { radius: 0, rgb: TOOL_RGB[this.tool], square: true };
    }
  }

  // --- pointer → orders ------------------------------------------------------

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
    if (!this.active) return; // "Off" → let the terrain editor handle it
    e.preventDefault();
    e.stopImmediatePropagation();
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.strokeSeen.clear();
    const c = this.cellAt(e);
    if (this.tool === 'line') this.orderLine(c, c);
    else if (this.tool === 'backburn') this.crew?.orderBackburn(c.x, c.y);
    else if (this.tool === 'direct') {
      this.crew?.standDown(); // a fresh held station replaces prior orders
      this.crew?.orderDirectAttack(c.x, c.y);
    } else if (this.tool === 'engine') {
      // orderDirectAttack already replaces any prior engine station (holds one edge).
      this.engine?.orderDirectAttack(c.x, c.y);
    } else if (this.tool === 'water') {
      this.aircraft?.orderWaterDrop(c.x, c.y);
    } else if (this.tool === 'retardant') {
      this.aircraft?.orderRetardantDrop(c.x, c.y);
    }
    this.last = c;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.active || !this.dragging) return;
    e.stopImmediatePropagation();
    const c = this.cellAt(e);
    if (this.tool === 'line') this.orderLine(this.last ?? c, c); // paint a continuous line
    this.last = c;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.active) return;
    e.stopImmediatePropagation();
    this.dragging = false;
    this.last = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  /** Enqueue one cut-line order per new cell along the stroke segment. */
  private orderLine(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const crew = this.crew;
    if (!crew) return; // the Line tool is not offered without a crew
    const { width, height } = this.world;
    forEachStrokeCell(width, height, from.x, from.y, to.x, to.y, 0, (x, y, i) => {
      if (this.strokeSeen.has(i)) return;
      this.strokeSeen.add(i);
      crew.orderCutLine(x, y);
    });
  }

  // --- overlay (called by the frame loop AFTER renderer.render) --------------

  /**
   * Draw the unit markers on the screen-resolution overlay (`overlay.ts` owns the
   * glyphs) and refresh the panel's water gauge. `vp` maps cells → overlay px.
   */
  render(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    drawUnitMarkers(ctx, { crew: this.crew, engine: this.engine, aircraft: this.aircraft }, vp);
    if (this.engine && this.waterGauge) {
      const eng = this.engine;
      const pct = Math.round(eng.waterFraction * 100);
      this.waterGauge.textContent = `Engine water: ${pct}%${eng.isRefilling ? ' (refilling…)' : ''}`;
    }
  }

  // --- toolbar (DOM) --------------------------------------------------------

  private buildToolbar(): void {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      padding: '10px 12px',
      font: '12px system-ui, sans-serif',
      color: '#e8e2dc',
      background: '#2a2320e6',
      border: '1px solid #4a3f38',
      borderRadius: '8px',
      boxShadow: '0 4px 18px #0007',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      userSelect: 'none',
      zIndex: '10',
      minWidth: '150px',
    } satisfies Partial<CSSStyleDeclaration>);

    const title = document.createElement('div');
    title.textContent = 'Fire command';
    Object.assign(title.style, { fontWeight: '600', color: '#f0a35e', letterSpacing: '0.03em' });
    panel.appendChild(title);

    // Offer only the tools whose unit is wired. A button for an absent unit would
    // arm, swallow the pointer and quietly do nothing — the failure this prevents.
    const wired: Record<Exclude<ToolNeeds, null>, boolean> = {
      crew: this.crew !== undefined,
      engine: this.engine !== undefined,
      aircraft: this.aircraft !== undefined,
    };
    const tools = TOOLS.filter((t) => t.needs === null || wired[t.needs]);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    for (const t of tools) {
      const btn = document.createElement('button');
      btn.textContent = t.label;
      Object.assign(btn.style, buttonStyle);
      if (t.id === this.tool) btn.style.background = ACCENT;
      btn.addEventListener('click', () => {
        this.tool = t.id;
        for (const child of Array.from(row.children)) {
          (child as HTMLElement).style.background = child === btn ? ACCENT : '#3a322c';
        }
      });
      row.appendChild(btn);
    }
    panel.appendChild(row);

    const stand = document.createElement('button');
    stand.textContent = 'Stand down';
    Object.assign(stand.style, { ...buttonStyle, alignSelf: 'flex-start' });
    stand.addEventListener('click', () => {
      this.crew?.standDown();
      this.engine?.standDown();
      this.aircraft?.standDown();
    });
    panel.appendChild(stand);

    if (this.engine) {
      const gauge = document.createElement('div');
      gauge.textContent = 'Engine water: 100%';
      Object.assign(gauge.style, { color: '#9be8c0', fontVariantNumeric: 'tabular-nums' });
      panel.appendChild(gauge);
      this.waterGauge = gauge;
    }

    document.body.appendChild(panel);
  }
}

/** Armed-tool accent: ember red — the panel commands fire, the editor's is earth-orange. */
const ACCENT = '#c0392b';

const buttonStyle: Partial<CSSStyleDeclaration> = {
  padding: '4px 8px',
  font: 'inherit',
  color: '#e8e2dc',
  background: '#3a322c',
  border: '1px solid #4a3f38',
  borderRadius: '4px',
  cursor: 'pointer',
};
