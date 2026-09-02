import { CanvasRenderer } from './render/canvasRenderer';
import { drawWindOverlay } from './render/overlay';
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

// A screen-resolution overlay canvas for crisp vector overlays (wind arrows).
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const overlayCtx = overlay.getContext('2d')!;

// Terrain editor (Phase-2 step 5): brush-paint over the data layers. Writes layer
// bytes only — never a system — so the invariants hold. It owns a pause flag so
// you can author terrain without the front advancing.
const editor = new TerrainEditor(canvas, world);

// Phase-4 command shell: click/drag issues orders to the units (cut line, backburn,
// direct attack, engine station, aerial drops). Browser-only, like the editor; it
// enqueues orders and draws the unit markers — it never writes world state itself.
const command = crew ? new SuppressionCommand(canvas, world, crew, engine ?? undefined, aircraft ?? undefined) : null;

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
    if (!on) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
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
// the demo runs at 60–300× real time to be watchable. Steps per frame are capped
// so a slow machine slows the clock rather than freezing the page.
const stats = emptyStats();
let last = performance.now();
let carry = 0;
let frameNo = 0;

function frame(now: number): void {
  const elapsed = Math.min(0.25, (now - last) / 1000); // clamp a background-tab jump
  last = now;
  if (!editor.paused && timeScale > 0) {
    carry += elapsed * timeScale;
    const steps = Math.min(40, Math.floor(carry / DT));
    for (let i = 0; i < steps; i++) sim.step(DT);
    carry -= steps * DT;
    if (steps === 40) carry = 0; // fell behind: drop the backlog, keep the frame rate
  }
  // Always render, even when paused, so brush strokes appear immediately.
  renderer.render(world);
  // Overlay the unit markers on top of the freshly-drawn frame.
  command?.render();
  if (windOverlay) {
    sizeOverlay();
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    drawWindOverlay(overlayCtx, world, overlay.width, overlay.height);
  }
  // Stats are one O(cells) pass; every third frame is plenty for a readout.
  if (frameNo++ % 3 === 0) {
    computeStats(world, burnableCells, stats);
    hud.update(stats, { crew, engine, aircraft });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
