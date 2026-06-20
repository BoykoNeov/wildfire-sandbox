import { createWorld } from './core/world';
import { Simulation } from './core/simulation';
import { generateTerrain, igniteNearestBurnable } from './gen/terrain';
import { BasicFuelModel } from './sim/basicFuelModel';
import { UniformWeatherProvider } from './sim/uniformWeather';
import { CaFireModel } from './sim/caFireModel';
import { CanvasRenderer } from './render/canvasRenderer';

const WIDTH = 256;
const HEIGHT = 256;
const SEED = 1337;
const DT = 1; // seconds of simulated time per step
const STEPS_PER_FRAME = 1;

// World state (plain data) + a seeded RNG from the very first frame.
const world = createWorld({ width: WIDTH, height: HEIGHT, seed: SEED });
generateTerrain(world);
// Light the nearest burnable cell to centre so the demo never lands on water/rock.
igniteNearestBurnable(world, WIDTH >> 1, HEIGHT >> 1);

// Systems talk only through the data layers, never to each other.
const fuel = new BasicFuelModel();
const weather = new UniformWeatherProvider(1.5, 0.6); // wind toward +x/+y
const fire = new CaFireModel(fuel);
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
