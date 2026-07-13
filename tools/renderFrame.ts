/**
 * Headless frame exporter — runs the real sim and writes a PNG using the SAME
 * shared palette the canvas renderer uses. This mirrors `main.ts`'s pipeline
 * (terrain gen -> uniform weather -> Rothermel ROS fire -> colour mapping)
 * without a browser, so the output is honest evidence of what the sandbox draws.
 * Includes the Phase-3 fuel-moisture system, dynamic (shifting, gusty) wind,
 * spotting, and a Phase-4 ground crew cutting a containment line
 * (weather -> moisture -> suppression -> fire -> spotting).
 *
 * Run: npx vite-node tools/renderFrame.ts
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createWorld, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { generateTerrain, igniteNearestBurnable } from '../src/gen/terrain';
import { TerrainFuelModel } from '../src/sim/terrainFuelModel';
import { DynamicWeatherProvider } from '../src/sim/dynamicWeather';
import { FuelMoistureSystem } from '../src/sim/fuelMoistureSystem';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { SpottingSystem } from '../src/sim/spottingSystem';
import { GroundCrew } from '../src/sim/groundCrew';
import { Engine } from '../src/sim/engine';
import { cellRGB, type Rgb } from '../src/render/palette';

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // per-scanline filter type 0 (none)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderToRgba(world: WorldState): Uint8Array {
  const n = world.width * world.height;
  const rgba = new Uint8Array(n * 4);
  const rgb: Rgb = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    cellRGB(world, i, rgb);
    const p = i * 4;
    rgba[p] = rgb.r;
    rgba[p + 1] = rgb.g;
    rgba[p + 2] = rgb.b;
    rgba[p + 3] = 255;
  }
  return rgba;
}

const WIDTH = 256;
const HEIGHT = 256;
const SEED = 1337;
// Rothermel ROS on 30 m cells is metres/min, so a visible burn scar needs far
// more sim-seconds than the Phase-1 CA did.
const STEPS = 2000;

const world = createWorld({ width: WIDTH, height: HEIGHT, seed: SEED });
generateTerrain(world);
igniteNearestBurnable(world, WIDTH >> 1, HEIGHT >> 1);

// Phase-4 4a: a ground crew cutting a vertical containment line east of the
// ignition, so `frame.png` is honest evidence a line gets drawn (tan scratch) and
// holds. The crew starts at the line's north end and cuts southward, order by order.
const crewFuel = new TerrainFuelModel();
const LINE_X = (WIDTH >> 1) + 24;
const LINE_Y0 = (HEIGHT >> 1) - 40;
const crew = new GroundCrew(crewFuel, { x: LINE_X, y: LINE_Y0 });
for (let y = LINE_Y0; y < LINE_Y0 + 80; y++) crew.orderCutLine(LINE_X, y);

// Phase-4 4b: an engine holding a station on the fire's southern flank with its
// finite tank, refilling from a staging point to the west — so the 2000-step run
// exercises the whole reload cycle in the real pipeline (weather → moisture →
// suppression → fire → spotting). Its wet knockdown leaves an unburned notch in the
// scar; while it is off refilling, the notch dries and the front creeps back — honest
// headless evidence the tank is finite.
const engine = new Engine({
  x: (WIDTH >> 1) + 8,
  y: (HEIGHT >> 1) + 30,
  refillX: (WIDTH >> 1) - 60,
  refillY: (HEIGHT >> 1) + 30,
});
engine.orderDirectAttack((WIDTH >> 1) + 8, (HEIGHT >> 1) + 30);

const sim = new Simulation(world, [
  // Same dynamic wind as main.ts: shifts NE → N → NW over 30 sim-minutes, gusty.
  new DynamicWeatherProvider(
    [
      { time: 0, u: 1.6, v: 0.7 },
      { time: 900, u: 0.2, v: 1.4 },
      { time: 1800, u: -1.5, v: 1.0 },
    ],
    { temperatureC: 30, relativeHumidity: 20, rainRate: 0, gust: { seed: SEED, speedAmp: 0.4, dirAmp: 0.35 } },
  ),
  new FuelMoistureSystem(),
  // Suppression sits after moisture, before fire (weather → moisture → suppression
  // → fire → spotting) so a same-tick line/backburn is honoured by the fire model.
  crew,
  engine,
  new RothermelFireModel(new TerrainFuelModel()),
  // Spotting runs after the fire model (additive `fire`-layer co-writer).
  new SpottingSystem(new TerrainFuelModel()),
]);
sim.run(STEPS, 1);

const out = 'frame.png';
writeFileSync(out, encodePng(WIDTH, HEIGHT, renderToRgba(world)));
console.log(`wrote ${out} — ${WIDTH}x${HEIGHT}, ${STEPS} steps, seed ${SEED}`);
