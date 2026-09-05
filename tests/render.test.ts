import { describe, it, expect } from 'vitest';
import { FireState } from '../src/core/world';
import { loadScenario } from '../src/scenario/scenario';
import { findPreset } from '../src/scenario/presets';
import { Fuel } from '../src/sim/basicFuelModel';
import { invalidateGroundColours, invalidateTerrainShading, renderRGBA, VIEW_MODES } from '../src/render/palette';

/**
 * The shared frame composition (`renderRGBA`) is what both the canvas and the
 * PNG exporter draw, so its invariants are pinned headlessly: every view renders
 * opaque pixels, a frame is a pure function of world state (deterministic, and
 * the sim's RNG is never touched), the per-world shading cache is invalidated
 * correctly when elevation is painted, and smoke is a terrain-view-only effect.
 */
/**
 * A preset shrunk to 96² with a centre ignition and no units: the same terrain
 * generator and pipeline, ~7× cheaper per step, so these tests stay fast under
 * vitest (whose module transform makes tight loops several times slower than the
 * browser — see tools/profile.ts).
 */
function small(id: string, steps: number) {
  const p = findPreset(id)!;
  const { world, sim } = loadScenario({ ...p, width: 96, height: 96, ignitions: 'center', agents: undefined });
  sim.run(steps, 1);
  return { world, sim };
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function frameOf(id: string, steps: number, view = 'terrain' as (typeof VIEW_MODES)[number]['id'], smoke = true) {
  const { world } = small(id, steps);
  const rgba = new Uint8ClampedArray(world.width * world.height * 4);
  renderRGBA(world, rgba, { view, smoke });
  return { world, rgba };
}

describe('renderRGBA — shared frame composition', () => {
  it('renders every view fully opaque with in-range bytes', () => {
    const { world } = small('grass-valley', 300);
    const rgba = new Uint8Array(world.width * world.height * 4);
    for (const v of VIEW_MODES) {
      rgba.fill(7);
      renderRGBA(world, rgba, { view: v.id });
      for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255);
    }
  });

  it('is a pure function of world state: same world, same bytes; the RNG is untouched', () => {
    const a = frameOf('timber-crown-run', 500);
    const b = frameOf('timber-crown-run', 500);
    expect(sameBytes(a.rgba, b.rgba)).toBe(true);
    // Rendering twice more must not perturb the sim: the RNG stream is not consumed.
    const before = a.world.rng.next();
    const b2 = frameOf('timber-crown-run', 500);
    renderRGBA(b2.world, b2.rgba, { view: 'terrain' });
    renderRGBA(b2.world, b2.rgba, { view: 'intensity' });
    expect(b2.world.rng.next()).toBe(before);
  });

  it('shows the fire: burning cells are hot (red-dominant) and the scar differs from the ground', () => {
    const { world, rgba } = frameOf('grass-valley', 500, 'terrain', false);
    const fire = world.layers.fire.data;
    let burning = 0;
    for (let i = 0; i < fire.length; i++) {
      if (fire[i] !== FireState.Burning) continue;
      burning++;
      expect(rgba[i * 4]).toBeGreaterThan(200); // red channel saturated
      expect(rgba[i * 4]).toBeGreaterThan(rgba[i * 4 + 2]); // hotter than blue
    }
    expect(burning).toBeGreaterThan(0);
  });

  it('smoke only touches the terrain view, and does touch it downwind of a fire', () => {
    const { world } = small('grass-valley', 500);
    const n = world.width * world.height * 4;
    const on = new Uint8ClampedArray(n);
    const off = new Uint8ClampedArray(n);
    renderRGBA(world, on, { view: 'terrain', smoke: true });
    renderRGBA(world, off, { view: 'terrain', smoke: false });
    let changed = 0;
    for (let i = 0; i < n; i++) if (on[i] !== off[i]) changed++;
    expect(changed).toBeGreaterThan(100);
    for (const v of VIEW_MODES) {
      if (v.id === 'terrain') continue;
      renderRGBA(world, on, { view: v.id, smoke: true });
      renderRGBA(world, off, { view: v.id, smoke: false });
      expect(sameBytes(on, off)).toBe(true);
    }
  });

  it('amortises smoke across frames: the field persists, so a second frame differs', () => {
    const { world } = small('grass-valley', 500);
    const n = world.width * world.height * 4;
    const a = new Uint8ClampedArray(n);
    const b = new Uint8ClampedArray(n);
    renderRGBA(world, a, { view: 'terrain', smoke: true }); // cold start: every source
    renderRGBA(world, b, { view: 'terrain', smoke: true }); // decay + one quarter
    expect(sameBytes(a, b)).toBe(false);
  });

  it('the amortised smoke field holds the same average density as a cold start', () => {
    // The deposit gain is calibrated so re-laying a quarter of the sources per
    // frame under exponential decay reproduces the stateless field's mean. Drift
    // here means the plumes would saturate (too high) or fade out (too low).
    const { world } = small('grass-valley', 500);
    const n = world.width * world.height * 4;
    const off = new Uint8ClampedArray(n);
    const on = new Uint8ClampedArray(n);
    renderRGBA(world, off, { view: 'terrain', smoke: false }); // also arms a cold start
    const deviation = () => {
      let d = 0;
      for (let i = 0; i < n; i++) d += Math.abs(on[i] - off[i]);
      return d;
    };
    renderRGBA(world, on, { view: 'terrain', smoke: true });
    const cold = deviation();
    for (let f = 0; f < 8; f++) renderRGBA(world, on, { view: 'terrain', smoke: true });
    const settled = deviation();
    expect(cold).toBeGreaterThan(0);
    expect(settled / cold).toBeGreaterThan(0.7);
    expect(settled / cold).toBeLessThan(1.43);
  });

  it('picks up a moisture change within the ground refresh cycle, or at once when invalidated', () => {
    // The terrain view's unburned ground is cached and rewritten one row band per
    // frame, so a moisture change shows within GROUND_BANDS frames — and
    // immediately when the editor invalidates after a paint stroke.
    const { world } = small('grass-valley', 10);
    const n = world.width * world.height;
    const rgba = new Uint8ClampedArray(n * 4);
    const fire = world.layers.fire.data;
    const fuel = world.layers.fuel.data;
    const moist = world.layers.moisture.data;
    let idx = -1;
    for (let i = 0; i < n; i++) {
      if (fire[i] === FireState.Unburned && fuel[i] === Fuel.Grass) {
        idx = i;
        break;
      }
    }
    expect(idx).toBeGreaterThanOrEqual(0);
    const pixel = () => [rgba[idx * 4], rgba[idx * 4 + 1], rgba[idx * 4 + 2]].join(',');
    renderRGBA(world, rgba, { view: 'terrain', smoke: false });
    const before = pixel();
    const orig = moist[idx];
    moist[idx] = orig > 127 ? 0 : 255;
    let framesToShow = -1;
    for (let f = 1; f <= 8; f++) {
      renderRGBA(world, rgba, { view: 'terrain', smoke: false });
      if (pixel() !== before) {
        framesToShow = f;
        break;
      }
    }
    expect(framesToShow).toBeGreaterThan(0); // it did show, within the 8-band cycle
    // Back to the original value: invalidating makes the very next frame show it.
    moist[idx] = orig;
    invalidateGroundColours(world);
    renderRGBA(world, rgba, { view: 'terrain', smoke: false });
    expect(pixel()).toBe(before);
  });

  it('flashes a fresh isolated ignition, and leaves an ordinary front byte-identical', () => {
    // Hand-built so the assertion is exact: a preset run would hand us genuine
    // spot fires from SpottingSystem and break the identity half.
    const { world } = small('grass-valley', 0);
    const n = world.width * world.height;
    const w = world.width;
    const fire = world.layers.fire.data;
    const age = world.layers.burnElapsed.data;
    fire.fill(FireState.Unburned);
    age.fill(0);
    // A normal front: burned interior, a leading row of flames whose neighbours
    // behind them ignited EARLIER but are still Burning (grass flames last ~6.6 s,
    // so they have not turned Burned yet — this is the case the plan's original
    // "no Burned neighbour" rule got wrong).
    for (let y = 20; y < 30; y++) {
      for (let x = 20; x < 40; x++) {
        const i = y * w + x;
        if (y < 27) {
          fire[i] = FireState.Burned;
        } else {
          fire[i] = FireState.Burning;
          age[i] = (30 - y) * 2; // older behind, youngest at the leading row
        }
      }
    }
    const on = new Uint8ClampedArray(n * 4);
    const off = new Uint8ClampedArray(n * 4);
    renderRGBA(world, on, { view: 'terrain', smoke: false, spotFlash: true });
    renderRGBA(world, off, { view: 'terrain', smoke: false, spotFlash: false });
    expect(sameBytes(on, off)).toBe(true); // no leakage into an ordinary front

    // Now an ember lands far away: a single Burning cell, nothing older near it.
    const spot = 70 * w + 70;
    fire[spot] = FireState.Burning;
    age[spot] = 0;
    renderRGBA(world, on, { view: 'terrain', smoke: false, spotFlash: true });
    renderRGBA(world, off, { view: 'terrain', smoke: false, spotFlash: false });
    expect(sameBytes(on, off)).toBe(false);
    expect(on[spot * 4 + 2]).toBeGreaterThan(off[spot * 4 + 2]); // the white core: blue is what the glow never adds
    // …and it fades out: at the end of the window the frames agree again.
    age[spot] = 12;
    renderRGBA(world, on, { view: 'terrain', smoke: false, spotFlash: true });
    renderRGBA(world, off, { view: 'terrain', smoke: false, spotFlash: false });
    expect(sameBytes(on, off)).toBe(true);
  });

  it('draws the spot flash on every view, not just terrain (unlike smoke)', () => {
    const { world } = small('grass-valley', 0);
    const n = world.width * world.height;
    world.layers.fire.data.fill(FireState.Unburned);
    world.layers.burnElapsed.data.fill(0);
    const spot = 50 * world.width + 50;
    world.layers.fire.data[spot] = FireState.Burning;
    const on = new Uint8ClampedArray(n * 4);
    const off = new Uint8ClampedArray(n * 4);
    for (const v of VIEW_MODES) {
      renderRGBA(world, on, { view: v.id, smoke: false, spotFlash: true });
      renderRGBA(world, off, { view: v.id, smoke: false, spotFlash: false });
      expect(sameBytes(on, off), v.id).toBe(false);
    }
  });

  it('caches hillshade per world and rebuilds it after invalidateTerrainShading', () => {
    const { world } = small('shifting-winds', 10);
    const n = world.width * world.height;
    const a = new Uint8ClampedArray(n * 4);
    const b = new Uint8ClampedArray(n * 4);
    const c = new Uint8ClampedArray(n * 4);
    renderRGBA(world, a, { view: 'elevation' });
    // Paint a ridge far from the fire. Without invalidation the cached shading is
    // stale and the frame must NOT change; after it, the relief must show.
    const elev = world.layers.elevation.data;
    for (let y = 20; y < 40; y++) for (let x = 20; x < 60; x++) elev[y * world.width + x] += 300;
    renderRGBA(world, b, { view: 'elevation' });
    invalidateTerrainShading(world);
    renderRGBA(world, c, { view: 'elevation' });
    // Hypsometric tint changes even from the stale cache (it reads elevation live)…
    expect(sameBytes(a, b)).toBe(false);
    // …but the hillshade at the ridge edge only changes once the cache is rebuilt.
    expect(sameBytes(b, c)).toBe(false);
  });
});
