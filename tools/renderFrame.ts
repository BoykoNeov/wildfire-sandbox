/**
 * Headless frame exporter — runs the real sim and writes a PNG using the SAME
 * shared palette the canvas renderer uses, built by the SAME `loadScenario` the
 * browser entry uses. So the output is honest evidence of what the sandbox draws.
 *
 * Run: npm run frame [-- <preset-id> [steps [view]]]   (default: shifting-winds, 2000, terrain)
 *      npx vite-node tools/renderFrame.ts timber-crown-run 3600 intensity
 *
 * On top of the preset it issues a fixed set of Phase-4 orders (a crew line, an
 * engine station with a reload cycle, one retardant drop) so the frame also shows
 * every suppression layer rendering. The mechanics are proven headlessly by the
 * tests; this is the smoke check.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import type { WorldState } from '../src/core/world';
import { renderRGBA, VIEW_MODES, type ViewMode } from '../src/render/palette';
import { loadScenario } from '../src/scenario/scenario';
import { findPreset, DEFAULT_PRESET_ID, PRESETS } from '../src/scenario/presets';

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

function renderToRgba(world: WorldState, view: ViewMode): Uint8Array {
  const rgba = new Uint8Array(world.width * world.height * 4);
  renderRGBA(world, rgba, { view }); // shared composition: per-cell colours + fire glow
  return rgba;
}

const presetId = process.argv[2] ?? DEFAULT_PRESET_ID;
const preset = findPreset(presetId);
if (!preset) {
  console.error(`unknown preset "${presetId}" — one of: ${PRESETS.map((p) => p.id).join(', ')}`);
  process.exit(1);
}
const STEPS = Number(process.argv[3] ?? 2000);
const VIEW = (process.argv[4] ?? 'terrain') as ViewMode;
if (!VIEW_MODES.some((v) => v.id === VIEW)) {
  console.error(`unknown view "${VIEW}" — one of: ${VIEW_MODES.map((v) => v.id).join(', ')}`);
  process.exit(1);
}

const { world, sim, crew, engine, aircraft } = loadScenario(preset);
const cx = world.width >> 1;
const cy = world.height >> 1;

// Phase-4 4a: a crew cutting a vertical containment line east of centre, so the
// frame shows a line (tan scratch) being built and holding.
if (crew) for (let y = cy - 40; y < cy + 40; y++) crew.orderCutLine(cx + 24, y);
// Phase-4 4b: an engine holding a station on the southern flank with its finite
// tank — the run exercises the whole reload cycle in the real pipeline.
engine?.orderDirectAttack(cx + 8, cy + 30);
// Phase-4 4c: one retardant drop north-east of centre — shows the `retardant`
// layer rendering (a slurry square, fading as RetardantSystem decays it).
aircraft?.orderRetardantDrop(cx + 30, cy - 24);

sim.run(STEPS, 1);

const out = 'frame.png';
writeFileSync(out, encodePng(world.width, world.height, renderToRgba(world, VIEW)));
console.log(`wrote ${out} — ${preset.id} (${VIEW}), ${world.width}x${world.height}, ${STEPS} steps, seed ${preset.seed}`);
