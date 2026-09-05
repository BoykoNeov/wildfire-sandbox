import type { Scenario } from '../scenario/scenario';
import type { GroundCrew } from '../sim/groundCrew';
import type { Engine } from '../sim/engine';
import type { Aircraft } from '../sim/aircraft';
import { compassToward, formatDuration, type SimStats } from '../sim/stats';
import {
  VIEW_MODES,
  canopyRamp,
  elevationRamp,
  heatRamp,
  moistureRamp,
  type Rgb,
  type ViewMode,
} from '../render/palette';

/**
 * Phase-5a HUD (`docs/plans/phase-5-polish.md` decision #1): a browser-only DOM
 * **reader**. It formats `SimStats` + agent getters each frame and owns the run
 * controls (scenario, speed, view, wind overlay, smoke). It writes nothing into
 * world state; control changes are reported through callbacks that `main.ts`
 * wires to the frame loop / renderer. Like `SuppressionCommand` it is outside
 * the determinism test.
 *
 * The **legend** under the view picker is drawn from the palette's own exported
 * ramp functions, so it can never drift from what the map shows.
 */

export interface HudCallbacks {
  onScenario(id: string): void;
  onTimeScale(scale: number): void;
  onView(mode: ViewMode): void;
  onWindOverlay(on: boolean): void;
  onSmoke(on: boolean): void;
  onSpotFlash(on: boolean): void;
}

export interface HudAgents {
  crew: GroundCrew | null;
  engine: Engine | null;
  aircraft: Aircraft | null;
}

/** Frame-loop timings the HUD shows in the Run panel (all smoothed by the caller). */
export interface HudPerf {
  /** Sim cost per step, ms. */
  simMsPerStep: number;
  /** Whole frame (sim + render + overlays), ms. */
  frameMs: number;
  /** Sim steps taken per animation frame (0 when paused). */
  stepsPerFrame: number;
}

/** Selectable sim speeds: sim-seconds per real second. */
const SPEEDS: ReadonlyArray<{ scale: number; label: string }> = [
  { scale: 0, label: '⏸' },
  { scale: 30, label: '30×' },
  { scale: 60, label: '60×' },
  { scale: 120, label: '120×' },
  { scale: 300, label: '300×' },
  { scale: 600, label: '600×' },
];

/** Sparkline sample spacing (sim seconds) and history length. */
const SPARK_EVERY = 120;
const SPARK_POINTS = 180; // 6 sim-hours

const STYLE = `
#hud { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 10;
  display: grid; grid-template-columns: minmax(220px, 1.1fr) minmax(300px, 380px) minmax(300px, 1.4fr); gap: 10px;
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
#hud canvas.spark { display: block; width: 100%; height: 34px; margin-top: 4px; background: #1f1915; border-radius: 3px; }
#hud .legend { margin-top: 6px; font-size: 11px; color: #b8ada4; max-width: 340px; }
#hud .legend canvas { display: block; width: 100%; height: 8px; border-radius: 2px; }
#hud .legend .ends { display: flex; justify-content: space-between; margin-top: 1px; font-variant-numeric: tabular-nums; }
#hud .legend .sw { display: flex; flex-wrap: wrap; gap: 3px 10px; max-width: 260px; }
#hud .legend .sw span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
#hud .legend .sw i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; border: 1px solid #0006; }
#hud .perf { margin-top: 6px; color: #8d8378; font-size: 11px; font-variant-numeric: tabular-nums; }
@media (max-width: 900px) { #hud { grid-template-columns: 1fr; } }
`;

export class Hud {
  private readonly root: HTMLElement;
  private readonly speedButtons = new Map<number, HTMLButtonElement>();
  private readonly cells = new Map<string, HTMLElement>();
  private readonly spark: HTMLCanvasElement;
  private readonly sparkCtx: CanvasRenderingContext2D;
  private readonly legend: HTMLElement;
  private readonly perf: HTMLElement;
  private readonly history: number[] = [];
  private nextSample = 0;
  private windOn = false;
  private smokeOn = true;
  private spotFlashOn = true;

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
    view.addEventListener('change', () => {
      const mode = view.value as ViewMode;
      cb.onView(mode);
      this.drawLegend(mode);
    });
    viewRow.appendChild(view);
    const wind = document.createElement('button');
    wind.textContent = 'Wind arrows';
    wind.title = 'Overlay the wind field as arrows (length and brightness scale with speed)';
    wind.addEventListener('click', () => {
      this.windOn = !this.windOn;
      wind.classList.toggle('on', this.windOn);
      cb.onWindOverlay(this.windOn);
    });
    viewRow.appendChild(wind);
    const smoke = document.createElement('button');
    smoke.textContent = 'Smoke';
    smoke.title = 'Smoke plumes downwind of flaming and smouldering cells (terrain view; a visual cue, not a dispersion model)';
    smoke.classList.toggle('on', this.smokeOn);
    smoke.addEventListener('click', () => {
      this.smokeOn = !this.smokeOn;
      smoke.classList.toggle('on', this.smokeOn);
      cb.onSmoke(this.smokeOn);
    });
    viewRow.appendChild(smoke);
    const spots = document.createElement('button');
    spots.textContent = 'Spot flash';
    spots.title =
      'Flash a fresh isolated ignition white-hot for ~12 simulated seconds — where an ember landed, a click, a backburn going in. ' +
      'Turn it off to see only the fire that grows out of it, the way an observer on the ground would. Brief at high speed.';
    spots.classList.toggle('on', this.spotFlashOn);
    spots.addEventListener('click', () => {
      this.spotFlashOn = !this.spotFlashOn;
      spots.classList.toggle('on', this.spotFlashOn);
      cb.onSpotFlash(this.spotFlashOn);
    });
    viewRow.appendChild(spots);
    ct.appendChild(viewRow);

    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    ct.appendChild(this.legend);
    this.drawLegend('terrain');

    this.perf = document.createElement('div');
    this.perf.className = 'perf';
    this.perf.textContent = '';
    ct.appendChild(this.perf);
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
    this.spark.className = 'spark';
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

  /** Format the latest stats + unit states. Called every few animation frames. */
  update(s: SimStats, agents: HudAgents, perf?: HudPerf): void {
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

    if (perf) {
      this.perf.textContent =
        `sim ${perf.simMsPerStep.toFixed(2)} ms/step · ${perf.stepsPerFrame.toFixed(1)} steps/frame · frame ${perf.frameMs.toFixed(1)} ms`;
    }

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

  // --- legend -----------------------------------------------------------------

  /** Rebuild the legend for a view: a colour ramp with end labels, or swatches. */
  private drawLegend(mode: ViewMode): void {
    const el = this.legend;
    el.replaceChildren();
    switch (mode) {
      case 'terrain':
        el.appendChild(swatches([
          ['#ffd27a', 'flame'],
          ['#fff6e6', 'crown run'],
          ['#b06a3a', 'smouldering edge'],
          ['#2b221d', 'char'],
          ['#767068', 'ash (crown consumed)'],
          ['#c8462d', 'retardant'],
          ['#c2a878', 'cut line'],
          ['#dcdadd', 'smoke'],
          ['#6a6a5a', 'contour 50 m'],
        ]));
        return;
      case 'fuel':
        el.appendChild(swatches([
          ['rgb(214,196,92)', 'grass'],
          ['rgb(150,128,60)', 'brush'],
          ['rgb(48,96,52)', 'timber'],
          ['rgb(120,118,112)', 'rock'],
          ['rgb(58,96,150)', 'water'],
          ['rgb(220,190,130)', 'cut line'],
        ]));
        return;
      case 'moisture':
        el.appendChild(ramp((t, o) => moistureRamp(t * 0.4, o), ['0 %', '15 % (Mx band)', '40 %+'], 'dead-fuel moisture'));
        return;
      case 'elevation':
        el.appendChild(ramp(elevationRamp, ['0 m', '500 m', '1000 m'], 'elevation (50 m contours)'));
        return;
      case 'canopy':
        el.appendChild(ramp(canopyRamp, ['bare', '', 'dense overstory'], 'canopy cover / bulk density'));
        return;
      case 'intensity':
        el.appendChild(ramp((t, o) => heatRamp(Math.pow(10, 1 + 3 * t), o), ['10', '300', '10 000 kW/m'], 'fireline intensity of the front that took the cell (log)'));
        return;
    }
  }
}

function fmtKw(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0);
}

/** A horizontal colour ramp drawn from a palette ramp function, with end labels. */
function ramp(fn: (t: number, out: Rgb) => void, labels: [string, string, string], title: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.title = title;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 1;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(256, 1);
  const rgb: Rgb = { r: 0, g: 0, b: 0 };
  for (let x = 0; x < 256; x++) {
    fn(x / 255, rgb);
    img.data[x * 4] = rgb.r;
    img.data[x * 4 + 1] = rgb.g;
    img.data[x * 4 + 2] = rgb.b;
    img.data[x * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  wrap.appendChild(c);
  const ends = document.createElement('div');
  ends.className = 'ends';
  for (const l of labels) {
    const s = document.createElement('span');
    s.textContent = l;
    ends.appendChild(s);
  }
  wrap.appendChild(ends);
  return wrap;
}

/** A row of colour swatches with names. */
function swatches(items: Array<[string, string]>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sw';
  for (const [color, name] of items) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = color;
    s.append(i, document.createTextNode(name));
    row.appendChild(s);
  }
  return row;
}
