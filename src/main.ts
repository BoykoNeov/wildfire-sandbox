import { CanvasRenderer } from './render/canvasRenderer';
import { drawBrushCursor, drawWindOverlay, makeViewport } from './render/overlay';
import { TerrainEditor } from './editor/terrainEditor';
import { SuppressionCommand } from './editor/suppressionCommand';
import { loadScenario } from './scenario/scenario';
import { findPreset, DEFAULT_PRESET_ID, PRESETS } from './scenario/presets';
import { computeStats, emptyStats } from './sim/stats';
import { Hud } from './ui/hud';

const DT = 1; // seconds of simulated time per step

// Pick the scenario from the URL (?scenario=<id>) so a unit is linkable; the
// default is the shifting-winds demo. `loadScenario` is the single pipeline
// builder shared with the headless exporter, so the browser and `npm run frame`
// can never drift apart (Phase-5 plan decision #4).
const params = new URLSearchParams(window.location.search);
const preset = findPreset(params.get('scenario') ?? DEFAULT_PRESET_ID) ?? findPreset(DEFAULT_PRESET_ID)!;
const loaded = loadScenario(preset);
const { world, sim, crew, engine, aircraft, burnableCells } = loaded;

// Rendering reads world state but never drives the sim.
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas, world);

// A screen-resolution overlay canvas for crisp vector overlays: wind arrows,
// unit markers, the brush / order cursor. Cleared and redrawn every frame.
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const overlayCtx = overlay.getContext('2d')!;

// Terrain editor (Phase-2 step 5): brush-paint over the data layers. Writes layer
// bytes only — never a system — so the invariants hold. It owns a pause flag so
// you can author terrain without the front advancing. Painting elevation or fuel
// invalidates the renderer's cached hillshade / contours.
const editor = new TerrainEditor(canvas, world, {
  onPaint: (tool) => {
    if (tool === 'elevation' || tool === 'fuel') renderer.invalidateTerrain();
  },
});

// Phase-4 command shell: click/drag issues orders to the units (cut line, backburn,
// direct attack, engine station, aerial drops). Browser-only, like the editor; it
// enqueues orders and draws the unit markers — it never writes world state itself.
// Built whenever the scenario wires ANY unit, and every unit is independently
// optional: the panel offers exactly the tools whose unit exists, so a roster that
// omits (say) the hand crew still commands its engine and air tanker. Only a
// scenario with no `agents` at all gets no panel, which is what it asked for.
const command =
  crew || engine || aircraft
    ? new SuppressionCommand(canvas, world, crew ?? undefined, engine ?? undefined, aircraft ?? undefined)
    : null;

// Run state owned by the page: pacing, view mode, overlays. The HUD reports
// control changes through callbacks and formats stats each frame (Phase-5a).
let timeScale = preset.timeScale ?? 120; // sim-seconds per real second; 0 = paused
let windOverlay = false;
const hud = new Hud(PRESETS, preset, timeScale, {
  onScenario: (id) => {
    // Rebuilding world + systems + editor + command shell + renderer is exactly a
    // fresh page load with the id in the URL — so do that (the seed reproduces it).
    const url = new URL(window.location.href);
    url.searchParams.set('scenario', id);
    window.location.assign(url.toString());
  },
  onTimeScale: (scale) => {
    timeScale = scale;
  },
  onView: (mode) => {
    renderer.view = mode;
  },
  onWindOverlay: (on) => {
    windOverlay = on;
  },
  onSmoke: (on) => {
    renderer.smoke = on;
  },
});

function sizeOverlay(): void {
  const rect = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
}
window.addEventListener('resize', sizeOverlay);
sizeOverlay();

// Pace the sim by wall clock: `timeScale` sim-seconds per real second, whatever
// the display refresh rate. Rothermel ROS on 30 m cells is metres per minute, so
// the demo runs at 60–600× real time to be watchable. Steps per frame are capped
// so a slow machine slows the clock rather than freezing the page.
const MAX_STEPS_PER_FRAME = 40;
const stats = emptyStats();
let last = performance.now();
let carry = 0;
let frameNo = 0;
// Smoothed timings for the HUD's perf readout (exponential moving averages).
let simMsPerStep = 0;
let frameMs = 0;
let stepsPerFrame = 0;
const ema = (prev: number, x: number, k = 0.1): number => (prev === 0 ? x : prev + (x - prev) * k);

function frame(now: number): void {
  const frameStart = performance.now();
  const elapsed = Math.min(0.25, (now - last) / 1000); // clamp a background-tab jump
  last = now;
  let steps = 0;
  if (!editor.paused && timeScale > 0) {
    carry += elapsed * timeScale;
    steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(carry / DT));
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) sim.step(DT);
    if (steps > 0) simMsPerStep = ema(simMsPerStep, (performance.now() - t0) / steps);
    carry -= steps * DT;
    if (steps === MAX_STEPS_PER_FRAME) carry = 0; // fell behind: drop the backlog, keep the frame rate
  }
  stepsPerFrame = ema(stepsPerFrame, steps);

  // Always render, even when paused, so brush strokes appear immediately.
  renderer.render(world);

  // Overlays on the crisp screen-resolution canvas, on top of the fresh frame.
  sizeOverlay();
  const vp = makeViewport(world, overlay.width, overlay.height, window.devicePixelRatio || 1);
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (windOverlay) drawWindOverlay(overlayCtx, world, vp);
  command?.render(overlayCtx, vp);
  const hover = editor.hover;
  if (hover) {
    // The cursor shows what a click will do: the armed order's footprint when a
    // suppression tool is live, else the editor brush.
    const c = command?.active ? command.cursor : editor.cursor;
    drawBrushCursor(overlayCtx, vp, hover.x, hover.y, c.radius, c.rgb, c.square);
  }

  frameMs = ema(frameMs, performance.now() - frameStart);
  // Stats are one O(cells) pass; every third frame is plenty for a readout.
  if (frameNo++ % 3 === 0) {
    computeStats(world, burnableCells, stats);
    hud.update(stats, { crew, engine, aircraft }, { simMsPerStep, frameMs, stepsPerFrame });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
