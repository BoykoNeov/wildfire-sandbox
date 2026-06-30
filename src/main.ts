import { createWorld } from './core/world';
import { Simulation } from './core/simulation';
import { generateTerrain, igniteNearestBurnable } from './gen/terrain';
import { Anderson13FuelModel } from './sim/anderson13';
import { UniformWeatherProvider } from './sim/uniformWeather';
import { RothermelFireModel } from './sim/rothermelFireModel';
import { CanvasRenderer } from './render/canvasRenderer';

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
// fuel ids (Grass=1/Brush=2/Timber=3) are valid Anderson model numbers, so they
// map straight onto FM1/FM2/FM3. `CaFireModel`/`BasicFuelModel` remain in the tree
// as the Phase-1 reference (and back the determinism test).
const fuel = new Anderson13FuelModel();
// Wind vector read by the Rothermel model as midflame wind in m/s (plan §D3).
const weather = new UniformWeatherProvider(1.5, 0.6); // ≈ 1.6 m/s toward +x/+y
const fire = new RothermelFireModel(fuel);
const sim = new Simulation(world, [weather, fire]);

// Rendering reads world state but never drives the sim.
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas, world);

function frame(): void {
  for (let i = 0; i < STEPS_PER_FRAME; i++) sim.step(DT);
  renderer.render(world);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
