import { CanvasRenderer } from './render/canvasRenderer';
import { TerrainEditor } from './editor/terrainEditor';
import { SuppressionCommand } from './editor/suppressionCommand';
import { loadScenario } from './scenario/scenario';
import { findPreset, DEFAULT_PRESET_ID } from './scenario/presets';

const DT = 1; // seconds of simulated time per step

// Pick the scenario from the URL (?scenario=<id>) so a unit is linkable; the
// default is the original shifting-winds demo. `loadScenario` is the single
// pipeline builder shared with the headless exporter, so the browser and
// `npm run frame` can never drift apart (Phase-5 plan decision #4).
const params = new URLSearchParams(window.location.search);
const preset = findPreset(params.get('scenario') ?? DEFAULT_PRESET_ID) ?? findPreset(DEFAULT_PRESET_ID)!;
const loaded = loadScenario(preset);
const { world, sim, crew, engine, aircraft } = loaded;

// Rendering reads world state but never drives the sim.
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas, world);

// Terrain editor (Phase-2 step 5): brush-paint over the data layers. Writes layer
// bytes only — never a system — so the invariants hold. It owns a pause flag so
// you can author terrain without the front advancing.
const editor = new TerrainEditor(canvas, world);

// Phase-4 command shell: click/drag issues orders to the units (cut line, backburn,
// direct attack, engine station, aerial drops). Browser-only, like the editor; it
// enqueues orders and draws the unit markers — it never writes world state itself.
const command = crew ? new SuppressionCommand(canvas, world, crew, engine ?? undefined, aircraft ?? undefined) : null;

// Pace the sim by wall clock: `timeScale` sim-seconds per real second, whatever the
// display refresh rate. Rothermel ROS on 30 m cells is metres per minute, so the
// demo runs at 60–120× real time to be watchable.
const timeScale = preset.timeScale ?? 120;
let last = performance.now();
let carry = 0;

function frame(now: number): void {
  const elapsed = Math.min(0.25, (now - last) / 1000); // clamp a background-tab jump
  last = now;
  if (!editor.paused) {
    carry += elapsed * timeScale;
    const steps = Math.min(600, Math.floor(carry / DT));
    for (let i = 0; i < steps; i++) sim.step(DT);
    carry -= steps * DT;
  }
  // Always render, even when paused, so brush strokes appear immediately.
  renderer.render(world);
  // Overlay the unit markers on top of the freshly-drawn frame.
  command?.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
