import { createWorld } from './core/world';
import { Simulation } from './core/simulation';
import { generateTerrain, igniteNearestBurnable } from './gen/terrain';
import { TerrainFuelModel } from './sim/terrainFuelModel';
import { UniformWeatherProvider } from './sim/uniformWeather';
import { FuelMoistureSystem } from './sim/fuelMoistureSystem';
import { RothermelFireModel } from './sim/rothermelFireModel';
import { CanvasRenderer } from './render/canvasRenderer';
import { TerrainEditor } from './editor/terrainEditor';

const WIDTH = 256;
const HEIGHT = 256;
const SEED = 1337;
const DT = 1; // seconds of simulated time per step
const STEPS_PER_FRAME = 2; // Rothermel ROS on 30 m cells is slow; advance a touch faster.

// World state (plain data) + a seeded RNG from the very first frame.
const world = createWorld({ width: WIDTH, height: HEIGHT, seed: SEED });
generateTerrain(world);
// Light the nearest burnable cell to centre so the demo never lands on water/rock.
igniteNearestBurnable(world, WIDTH >> 1, HEIGHT >> 1);

// Systems talk only through the data layers, never to each other. The Phase-2
// pair: Anderson 13 fuels feeding the Rothermel ROS fire model. Terrain's generic
// fuel ids (Grass/Brush/Timber) are remapped onto representative Anderson models
// (FM1/FM6/FM9) by `TerrainFuelModel` — see that module for the choices. Timber is
// no longer mis-served as tall grass. `CaFireModel`/`BasicFuelModel` remain in the
// tree as the Phase-1 reference (and back the determinism test).
const fuel = new TerrainFuelModel();
// Wind vector read by the Rothermel model as midflame wind in m/s (plan §D3); the
// ambient drivers feed the Phase-3 fuel-moisture dynamics (dry, no rain by default).
const weather = new UniformWeatherProvider(1.5, 0.6, {
  temperatureC: 30,
  relativeHumidity: 20,
  rainRate: 0,
});
// Phase 3: dead-fuel moisture evolves toward EMC each tick. Ordered weather →
// moisture → fire so the fire model reads the freshly-updated moisture. Writes the
// moisture layer only; systems talk through layers (Handoff §3.1).
const moisture = new FuelMoistureSystem();
const fire = new RothermelFireModel(fuel);
const sim = new Simulation(world, [weather, moisture, fire]);

// Rendering reads world state but never drives the sim.
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas, world);

// Terrain editor (Phase-2 step 5): brush-paint over the data layers. Writes layer
// bytes only — never a system — so the invariants hold. It owns a pause flag so
// you can author terrain without the front advancing.
const editor = new TerrainEditor(canvas, world);

function frame(): void {
  if (!editor.paused) {
    for (let i = 0; i < STEPS_PER_FRAME; i++) sim.step(DT);
  }
  // Always render, even when paused, so brush strokes appear immediately.
  renderer.render(world);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
