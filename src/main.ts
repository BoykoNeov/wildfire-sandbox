import { CanvasRenderer } from './render/canvasRenderer';
import {
  drawBrushCursor,
  drawWindOverlay,
  makeViewport,
  WindParticles,
  type WindOverlayMode,
} from './render/overlay';
import { TerrainEditor } from './editor/terrainEditor';
import { SuppressionCommand } from './editor/suppressionCommand';
import {
  loadScenario,
  scaleScenario,
  MIN_SCENARIO_SIZE,
  MAX_SCENARIO_SIZE,
} from './scenario/scenario';
import { findPreset, DEFAULT_PRESET_ID, PRESETS } from './scenario/presets';
import { computeStats, emptyStats } from './sim/stats';
import { Hud } from './ui/hud';

const DT = 1; // seconds of simulated time per step

// Pick the scenario from the URL (?scenario=<id>) so a unit is linkable; the
// default is the shifting-winds demo. `loadScenario` is the single pipeline
// builder shared with the headless exporter, so the browser and `npm run frame`
// can never drift apart (Phase-5 plan decision #4).
// `?size=N` re-authors that preset for a square map N cells a side (the preset's
// own size, 256, is the default). The terrain generator samples in normalized
// coordinates, so it is the same landscape with more ground under it — see
// `scaleScenario` for what that costs in slope.
const params = new URLSearchParams(window.location.search);
const authored = findPreset(params.get('scenario') ?? DEFAULT_PRESET_ID) ?? findPreset(DEFAULT_PRESET_ID)!;
const requested = Number(params.get('size'));
const preset = Number.isFinite(requested) && requested > 0
  ? scaleScenario(
      authored,
      Math.round(Math.min(MAX_SCENARIO_SIZE, Math.max(MIN_SCENARIO_SIZE, requested))),
    )
  : authored;
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
// invalidates the renderer's cached hillshade / contours; painting moisture or
// canopy invalidates the cached unburned-cell colours (which otherwise refresh a
// band a frame, so a drag-paint would appear in stripes). Canopy is in that list
// because the canopy view's colours are cached too, not only the terrain view's.
const editor = new TerrainEditor(canvas, world, {
  onPaint: (tool) => {
    if (tool === 'elevation' || tool === 'fuel') renderer.invalidateTerrain();
    else if (tool === 'moisture' || tool === 'canopy') renderer.invalidateGround();
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
let windOverlay: WindOverlayMode = 'off';
// Built once, not per frame — the streamlines only mean anything because they
// carry their own trail state between frames. A scenario change is a full page
// reload, so there is no re-init path to keep in sync.
const windParticles = new WindParticles(world);
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
  onWindOverlay: (mode) => {
    windOverlay = mode;
  },
  onSmoke: (on) => {
    renderer.smoke = on;
  },
  onSpotFlash: (on) => {
    renderer.spotFlash = on;
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
  if (windOverlay === 'arrows') {
    drawWindOverlay(overlayCtx, world, vp);
  } else if (windOverlay === 'streamlines') {
    // Advected in real seconds (`elapsed`), never `elapsed * timeScale`: at 600×
    // a particle would cross the whole map in one frame. See WindParticles.
    windParticles.update(world, elapsed);
    windParticles.draw(overlayCtx, vp);
  }
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
