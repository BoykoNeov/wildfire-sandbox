import type { Scenario } from '../scenario/scenario';
import type { GroundCrew } from '../sim/groundCrew';
import type { Engine } from '../sim/engine';
import type { Aircraft } from '../sim/aircraft';
import { compassToward, formatDuration, type SimStats } from '../sim/stats';
import { VIEW_MODES, type ViewMode } from '../render/palette';

/**
 * Phase-5a HUD (`docs/plans/phase-5-polish.md` decision #1): a browser-only DOM
 * **reader**. It formats `SimStats` + agent getters each frame and owns the run
 * controls (scenario, speed, view, wind overlay). It writes nothing into world
 * state; control changes are reported through callbacks that `main.ts` wires to
 * the frame loop / renderer. Like `SuppressionCommand` it is outside the
 * determinism test.
 */

export interface HudCallbacks {
  onScenario(id: string): void;
  onTimeScale(scale: number): void;
  onView(mode: ViewMode): void;
  onWindOverlay(on: boolean): void;
}

export interface HudAgents {
  crew: GroundCrew | null;
  engine: Engine | null;
  aircraft: Aircraft | null;
}

/** Selectable sim speeds: sim-seconds per real second. */
const SPEEDS: ReadonlyArray<{ scale: number; label: string }> = [
  { scale: 0, label: '⏸' },
  { scale: 30, label: '30×' },
  { scale: 60, label: '60×' },
  { scale: 120, label: '120×' },
  { scale: 300, label: '300×' },
];

/** Sparkline sample spacing (sim seconds) and history length. */
const SPARK_EVERY = 120;
const SPARK_POINTS = 180; // 6 sim-hours

const STYLE = `
#hud { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 10;
  display: grid; grid-template-columns: minmax(220px, 1.1fr) auto minmax(300px, 1.4fr); gap: 10px;
  align-items: stretch; font: 12px/1.4 system-ui, sans-serif; color: #e8e2dc; user-select: none; pointer-events: none; }
#hud > * { pointer-events: auto; background: #2a2320e6; border: 1px solid #4a3f38; border-radius: 8px;
  box-shadow: 0 4px 18px #0007; padding: 8px 10px; }
#hud h2 { margin: 0 0 4px; font-size: 12px; font-weight: 650; letter-spacing: .03em; color: #f0a35e; }
#hud select, #hud button { font: inherit; color: #e8e2dc; background: #3a322c; border: 1px solid #4a3f38;
  border-radius: 4px; padding: 3px 7px; cursor: pointer; }
#hud button.on { background: #c8642c; }
#hud .desc { color: #b8ada4; font-size: 11.5px; margin-top: 4px; }
#hud .row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; }
#hud .row .lab { color: #b8ada4; width: 46px; }
#hud .grid { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 1px 10px; font-variant-numeric: tabular-nums; }
#hud .grid .k { color: #b8ada4; }
#hud .grid .v { text-align: right; }
#hud .v.hot { color: #ffb070; }
#hud .v.crown { color: #ffe9a8; }
#hud .v.wet { color: #9cc9ff; }
#hud canvas { display: block; width: 100%; height: 34px; margin-top: 4px; background: #1f1915; border-radius: 3px; }
@media (max-width: 900px) { #hud { grid-template-columns: 1fr; } }
`;

export class Hud {
  private readonly root: HTMLElement;
  private readonly speedButtons = new Map<number, HTMLButtonElement>();
  private readonly cells = new Map<string, HTMLElement>();
  private readonly spark: HTMLCanvasElement;
  private readonly sparkCtx: CanvasRenderingContext2D;
  private readonly history: number[] = [];
  private nextSample = 0;
  private windOn = false;

  constructor(
    presets: ReadonlyArray<Scenario>,
    current: Scenario,
    initialScale: number,
    private readonly cb: HudCallbacks,
  ) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'hud';

    // --- scenario ---------------------------------------------------------
    const sc = document.createElement('div');
    sc.innerHTML = '<h2>Scenario</h2>';
    const select = document.createElement('select');
    for (const p of presets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      if (p.id === current.id) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => cb.onScenario(select.value));
    sc.appendChild(select);
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = current.description;
    sc.appendChild(desc);
    this.root.appendChild(sc);

    // --- controls ---------------------------------------------------------
    const ct = document.createElement('div');
    ct.innerHTML = '<h2>Run</h2>';
    const speedRow = document.createElement('div');
    speedRow.className = 'row';
    speedRow.append(this.label('Speed'));
    for (const s of SPEEDS) {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.title = s.scale === 0 ? 'Pause' : `${s.scale} simulated seconds per real second`;
      b.addEventListener('click', () => this.setSpeed(s.scale, true));
      this.speedButtons.set(s.scale, b);
      speedRow.appendChild(b);
    }
    ct.appendChild(speedRow);
    this.setSpeed(initialScale, false);

    const viewRow = document.createElement('div');
    viewRow.className = 'row';
    viewRow.append(this.label('View'));
    const view = document.createElement('select');
    for (const v of VIEW_MODES) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.label;
      view.appendChild(o);
    }
    view.addEventListener('change', () => cb.onView(view.value as ViewMode));
    viewRow.appendChild(view);
    const wind = document.createElement('button');
    wind.textContent = 'Wind arrows';
    wind.addEventListener('click', () => {
      this.windOn = !this.windOn;
      wind.classList.toggle('on', this.windOn);
      cb.onWindOverlay(this.windOn);
    });
    viewRow.appendChild(wind);
    ct.appendChild(viewRow);
    this.root.appendChild(ct);

    // --- stats ------------------------------------------------------------
    const st = document.createElement('div');
    st.innerHTML = '<h2>Fire</h2>';
    const grid = document.createElement('div');
    grid.className = 'grid';
    const rows: Array<[string, string]> = [
      ['time', 'Sim time'],
      ['wind', 'Wind'],
      ['burning', 'Burning'],
      ['ambient', 'Ambient'],
      ['burned', 'Burned'],
      ['moist', 'Dead fuel'],
      ['consumed', 'Consumed'],
      ['front', 'Front'],
      ['crown', 'Crown'],
      ['line', 'Line'],
      ['units', 'Units'],
      ['retardant', 'Retardant'],
    ];
    for (const [key, name] of rows) {
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = name;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = '—';
      grid.append(k, v);
      this.cells.set(key, v);
    }
    st.appendChild(grid);
    this.spark = document.createElement('canvas');
    this.spark.width = 360;
    this.spark.height = 34;
    this.spark.title = 'Burned area over the last six simulated hours';
    this.sparkCtx = this.spark.getContext('2d')!;
    st.appendChild(this.spark);
    this.root.appendChild(st);

    document.body.appendChild(this.root);
  }

  private label(text: string): HTMLElement {
    const s = document.createElement('span');
    s.className = 'lab';
    s.textContent = text;
    return s;
  }

  /** Highlight the active speed; `notify` reports it to the frame loop. */
  setSpeed(scale: number, notify: boolean): void {
    for (const [s, b] of this.speedButtons) b.classList.toggle('on', s === scale);
    if (notify) this.cb.onTimeScale(scale);
  }

  /** Format the latest stats + unit states. Called once per animation frame. */
  update(s: SimStats, agents: HudAgents): void {
    const set = (key: string, text: string, cls = ''): void => {
      const el = this.cells.get(key)!;
      el.textContent = text;
      el.className = `v ${cls}`.trim();
    };
    set('time', formatDuration(s.time));
    set('wind', `${s.windSpeed.toFixed(1)} m/s → ${compassToward(s.windU, s.windV)}`);
    set('burning', `${s.burningHa.toFixed(1)} ha (${s.burningCells})`, s.burningCells > 0 ? 'hot' : '');
    const rain = s.rainRate > 0 ? ` · ${s.rainRate.toFixed(1)} mm/h` : '';
    set('ambient', `${s.temperatureC.toFixed(0)} °C · ${s.relativeHumidity.toFixed(0)}% RH${rain}`, s.rainRate > 0 ? 'wet' : '');
    set('burned', `${s.burnedHa.toFixed(1)} ha`);
    set('moist', `${(s.meanMoisture * 100).toFixed(1)}% moisture`, s.meanMoisture > 0.2 ? 'wet' : '');
    set('consumed', `${(s.consumedFraction * 100).toFixed(1)}% of burnable`);
    set('front', s.burningCells > 0 ? `${fmtKw(s.frontIntensityKwM)} kW/m · peak ${fmtKw(s.maxIntensityKwM)}` : `peak ${fmtKw(s.maxIntensityKwM)} kW/m`);
    const crown = s.crownActiveCells + s.crownPassiveCells;
    set('crown', crown > 0 ? `${s.crownActiveCells} active · ${s.crownPassiveCells} torching` : 'surface fire', s.crownActiveCells > 0 ? 'crown' : '');
    set('line', s.lineCutM > 0 ? `${s.lineCutM.toFixed(0)} m cut` : 'none');
    set('units', this.unitsText(agents));
    set('retardant', s.retardantCells > 0 ? `${s.retardantCells} cells active` : 'none');

    if (s.time >= this.nextSample) {
      this.history.push(s.burnedHa);
      if (this.history.length > SPARK_POINTS) this.history.shift();
      this.nextSample = s.time + SPARK_EVERY;
      this.drawSpark();
    }
  }

  private unitsText(a: HudAgents): string {
    const parts: string[] = [];
    if (a.crew) parts.push(`crew ${a.crew.isIdle ? 'idle' : a.crew.currentTask}`);
    if (a.engine) {
      parts.push(`engine ${Math.round(a.engine.waterFraction * 100)}%${a.engine.isRefilling ? ' refilling' : ''}`);
    }
    if (a.aircraft) parts.push(`tanker ${a.aircraft.isReturning ? 'reloading' : a.aircraft.isIdle ? 'ready' : 'sortie'}`);
    return parts.length ? parts.join(' · ') : 'none';
  }

  private drawSpark(): void {
    const ctx = this.sparkCtx;
    const w = this.spark.width;
    const h = this.spark.height;
    ctx.clearRect(0, 0, w, h);
    const hist = this.history;
    if (hist.length < 2) return;
    const max = Math.max(1e-6, ...hist);
    ctx.beginPath();
    for (let k = 0; k < hist.length; k++) {
      const x = (k / (SPARK_POINTS - 1)) * (w - 2) + 1;
      const y = h - 2 - (hist[k] / max) * (h - 6);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#f0a35e';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#b8ada4';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${max.toFixed(1)} ha`, w - 4, 11);
  }
}

function fmtKw(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0);
}
