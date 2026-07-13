import { createWorld } from './core/world';
import { Simulation } from './core/simulation';
import { generateTerrain, igniteNearestBurnable } from './gen/terrain';
import { TerrainFuelModel } from './sim/terrainFuelModel';
import { DynamicWeatherProvider } from './sim/dynamicWeather';
import { FuelMoistureSystem } from './sim/fuelMoistureSystem';
import { RothermelFireModel } from './sim/rothermelFireModel';
import { SpottingSystem } from './sim/spottingSystem';
import { GroundCrew } from './sim/groundCrew';
import { CanvasRenderer } from './render/canvasRenderer';
import { TerrainEditor } from './editor/terrainEditor';
import { SuppressionCommand } from './editor/suppressionCommand';

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
// Phase-3 dynamic wind (plan §"time-varying wind"). Midflame wind in m/s (plan §D3)
// that SHIFTS over the run — the headline event: it starts blowing ~NE, swings
// through calm, and settles blowing ~NW over 30 simulated minutes, so whichever
// flank is dangerous flips mid-scenario (Handoff §4.3). A drifting gust field
// makes the wind spatially varied — which is what makes the destination-cell
// sampling convention load-bearing (see world.ts windU/windV). Ambient drivers
// (dry, no rain) feed the Phase-3 fuel-moisture dynamics.
const weather = new DynamicWeatherProvider(
  [
    { time: 0, u: 1.6, v: 0.7 }, // blowing toward NE
    { time: 900, u: 0.2, v: 1.4 }, // swinging north…
    { time: 1800, u: -1.5, v: 1.0 }, // …settling toward NW
  ],
  {
    temperatureC: 30,
    relativeHumidity: 20,
    rainRate: 0,
    gust: { seed: SEED, speedAmp: 0.4, dirAmp: 0.35 },
  },
);
// Phase 3: dead-fuel moisture evolves toward EMC each tick. Ordered weather →
// moisture → fire so the fire model reads the freshly-updated moisture. Writes the
// moisture layer only; systems talk through layers (Handoff §3.1).
const moisture = new FuelMoistureSystem();
const fire = new RothermelFireModel(fuel);
// Phase 4 (4a): a player-commanded ground crew. Ordered weather → moisture →
// SUPPRESSION → fire → spotting (load-bearing, per each agent's header): a
// knockdown must land in the moisture layer after the drydown step and before the
// fire model reads it this tick, and a backburn must ignite in time to spread this
// tick. Layer-only, like spotting — it never touches the fire model's private
// progress. Player orders come from the browser command shell below (deterministic
// execution, non-deterministic commanding — outside the determinism test).
const crew = new GroundCrew(fuel, { x: WIDTH >> 1, y: (HEIGHT >> 1) + 24 });
// Phase 3: spotting. Burning cells throw embers downwind that jump ahead of the
// front (and across firebreaks). Ordered AFTER the fire model — it is an additive
// co-writer of the `fire` layer, layering ember ignitions on top of surface
// spread (see SpottingSystem for the contract). Reads the same fuel catalogue for
// landing-cell reception; talks only through layers (Handoff §3.1).
const spotting = new SpottingSystem(fuel);
const sim = new Simulation(world, [weather, moisture, crew, fire, spotting]);

// Rendering reads world state but never drives the sim.
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas, world);

// Terrain editor (Phase-2 step 5): brush-paint over the data layers. Writes layer
// bytes only — never a system — so the invariants hold. It owns a pause flag so
// you can author terrain without the front advancing.
const editor = new TerrainEditor(canvas, world);

// Phase-4 command shell: click/drag issues orders to the crew (cut line, backburn,
// direct attack). Browser-only, like the editor; it enqueues orders and draws the
// crew marker — it never writes world state itself. Shares the canvas with the
// editor via capture-phase pointer handling (see SuppressionCommand).
const command = new SuppressionCommand(canvas, world, crew);

function frame(): void {
  if (!editor.paused) {
    for (let i = 0; i < STEPS_PER_FRAME; i++) sim.step(DT);
  }
  // Always render, even when paused, so brush strokes appear immediately.
  renderer.render(world);
  // Overlay the crew marker on top of the freshly-drawn frame.
  command.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
