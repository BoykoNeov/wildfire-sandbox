/**
 * Headless profiler — runs a preset through the real pipeline and reports where
 * the time goes: ms/step per system (the sim side) and ms/frame per view for the
 * shared `renderRGBA` composition (the render side). The numbers are what the
 * browser frame loop pays, minus `putImageData` and the DOM.
 *
 * Run: npm run profile [-- <preset-id> [steps] [--size=N]]  (default: shifting-winds, 1500)
 *      npm run profile -- timber-crown-run 3000
 *      npm run profile -- timber-crown-run 1800 --size=512   (square map, centre ignition)
 *
 * The npm script bundles this file with esbuild and runs it under plain `node`
 * ON PURPOSE: `vite-node` (what `npm run frame` uses) rewrites every imported
 * binding into a property access on a module-namespace object, which V8 cannot
 * optimise in a hot loop — it made the tight typed-array sweeps read 5–10× slower
 * than they are in the browser or in the Vite production build. A bundled run is
 * representative; a vite-node run is not.
 *
 * Systems are timed individually by stepping them by hand in pipeline order —
 * the same order `Simulation.step` uses — so the per-system split is exact and
 * the run is byte-identical to `sim.run(steps, 1)`. Render is timed after the
 * run (a frame full of fire) so it measures the expensive case.
 */
import { renderRGBA, VIEW_MODES } from '../src/render/palette';
import { computeStats } from '../src/sim/stats';
import { loadScenario } from '../src/scenario/scenario';
import { findPreset, DEFAULT_PRESET_ID, PRESETS } from '../src/scenario/presets';

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
/** `--size 512`: run the preset on a square map of that side, ignition at centre. */
const sizeArg = process.argv.find((a) => a.startsWith('--size'));
const SIZE = sizeArg ? Number(sizeArg.split('=')[1] ?? process.argv[process.argv.indexOf(sizeArg) + 1]) : 0;

const presetId = argv[0] ?? DEFAULT_PRESET_ID;
const preset = findPreset(presetId);
if (!preset) {
  console.error(`unknown preset "${presetId}" — one of: ${PRESETS.map((p) => p.id).join(', ')}`);
  process.exit(1);
}
const STEPS = Number(argv[1] ?? 1500);

const scenario = SIZE > 0 ? { ...preset, width: SIZE, height: SIZE, ignitions: 'center' as const } : preset;
const { world, sim, systems, crew, engine, aircraft, burnableCells } = loadScenario(scenario);
const cx = world.width >> 1;
const cy = world.height >> 1;
// The same orders the frame exporter issues, so suppression systems have work.
if (crew) for (let y = cy - 40; y < cy + 40; y++) crew.orderCutLine(cx + 24, y);
engine?.orderDirectAttack(cx + 8, cy + 30);
aircraft?.orderRetardantDrop(cx + 30, cy - 24);

const perSystem = new Map<string, number>(systems.map((s) => [s.name, 0]));
let total = 0;
for (let step = 0; step < STEPS; step++) {
  const t0 = performance.now();
  for (const s of systems) {
    const a = performance.now();
    s.step(world, 1);
    perSystem.set(s.name, perSystem.get(s.name)! + (performance.now() - a));
  }
  world.clock.tick += 1;
  world.clock.time += 1;
  total += performance.now() - t0;
}
void sim; // built by loadScenario; stepped by hand above for the per-system split

const stats = computeStats(world, burnableCells);
console.log(`${preset.id}  ${world.width}x${world.height}  ${STEPS} steps  ` +
  `burning ${stats.burningCells}  burned ${stats.burnedCells}  crown ${stats.crownActiveCells}/${stats.crownPassiveCells}`);
console.log('\nsim (ms/step)');
for (const [name, ms] of perSystem) console.log(`  ${name.padEnd(28)} ${(ms / STEPS).toFixed(3)}`);
console.log(`  ${'TOTAL'.padEnd(28)} ${(total / STEPS).toFixed(3)}`);

const rgba = new Uint8ClampedArray(world.width * world.height * 4);
const FRAMES = 120;
console.log(`\nrender (ms/frame, ${FRAMES} frames)`);
function timeView(label: string, view: (typeof VIEW_MODES)[number]['id'], smoke?: boolean): void {
  for (let f = 0; f < 30; f++) renderRGBA(world, rgba, { view, smoke }); // JIT warm-up
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    world.clock.time += 0.016; // animate the flicker so the path is the live one
    renderRGBA(world, rgba, { view, smoke });
  }
  console.log(`  ${label.padEnd(28)} ${((performance.now() - t0) / FRAMES).toFixed(3)}`);
}
for (const v of VIEW_MODES) {
  timeView(v.id, v.id);
  // The terrain view minus smoke: `terrain - terrain (no smoke)` is the cost of
  // the plumes alone, which is the only number a smoke change should move (the
  // ground composition is a separate item).
  if (v.id === 'terrain') timeView('terrain (no smoke)', v.id, false);
}
{
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) computeStats(world, burnableCells, stats);
  console.log(`  ${'stats'.padEnd(28)} ${((performance.now() - t0) / FRAMES).toFixed(3)}`);
}
