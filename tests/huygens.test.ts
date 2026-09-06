import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import type { System } from '../src/core/system';
import { Anderson13FuelModel, ANDERSON_13, deadFuelBed } from '../src/sim/anderson13';
import { HuygensFireModel } from '../src/sim/huygensFireModel';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import { Fuel } from '../src/sim/basicFuelModel';
import { surfaceSpread, ftPerMinToMetersPerSec, metersPerSecToFtPerMin } from '../src/sim/rothermel';
import { byteToFraction } from '../src/core/moisture';
import { loadScenario } from '../src/scenario/scenario';
import { findPreset } from '../src/scenario/presets';

/**
 * Phase 11 Stage 1 acceptance gates for the marker front
 * (`docs/plans/phase-11-smooth-wavefront.md` §6).
 *
 * Two of these are the ones the plan insists on and the rest of the phase cannot
 * substitute for, because **a mirrored ellipse has identical anisotropy,
 * identical length-to-breadth at every wind speed and the same radius at every
 * angle off the axis**: the *expansion* gate (a ring must grow, not shrink) and
 * the *oblique-axis* gate (the fire must run the way the wind actually points,
 * signed). Everything else in §7's table is blind to that failure.
 */

const FM = 1; // FM1 short grass — a clean single-class dead bed.
const MOIST = 15; // ≈ 6% dead-fuel moisture.

/** Analytic head rate [m/s] at a midflame wind, flat ground — the target to hit. */
function analyticHeadMps(windMps: number): number {
  const bed = deadFuelBed(ANDERSON_13.get(FM)!, byteToFraction(MOIST));
  const { rateOfSpread } = surfaceSpread(bed, {
    midflameWind: metersPerSecToFtPerMin(windMps),
    tanSlope: 0,
  });
  return ftPerMinToMetersPerSec(rateOfSpread);
}

/**
 * A flat, homogeneous field with a single lit cell at the centre, sized so the
 * head travels `targetCells` cells in `steps` ticks — many ticks per cell, so
 * neither the per-tick integration nor the ±1-cell counting error dominates.
 */
function pointIgnition(size: number, steps: number, targetCells: number, windMps: number): WorldState {
  const cellSize = (analyticHeadMps(windMps) * steps) / targetCells;
  const world = createWorld({ width: size, height: size, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST);
  world.layers.fire.set(size >> 1, size >> 1, FireState.Burning);
  return world;
}

function runHuygens(world: WorldState, steps: number, weather?: System): void {
  const systems: System[] = [];
  if (weather) systems.push(weather);
  systems.push(new HuygensFireModel(new Anderson13FuelModel()));
  new Simulation(world, systems).run(steps, 1);
}

function burnedCells(world: WorldState): number {
  let n = 0;
  for (const v of world.layers.fire.data) if (v !== FireState.Unburned) n++;
  return n;
}

/** Distance in cells from the centre to the last ignited cell along a unit ray. */
function radius(world: WorldState, ux: number, uy: number): number {
  const cx = world.width >> 1;
  const cy = world.height >> 1;
  let r = 0;
  for (let t = 0.25; t < world.width; t += 0.25) {
    const x = Math.round(cx + ux * t);
    const y = Math.round(cy + uy * t);
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) break;
    if (world.layers.fire.get(x, y) === FireState.Unburned) break;
    r = t;
  }
  return r;
}

describe('Huygens marker front — the two gates nothing else can substitute for', () => {
  it('a seed ring under zero wind EXPANDS', () => {
    // The sign gate. Get the winding or the cross-product sign wrong and the ring
    // contracts instead — which is not subtle once you look, and completely
    // invisible in any shape statistic.
    const world = pointIgnition(41, 120, 12, 0);
    const model = new HuygensFireModel(new Anderson13FuelModel());
    const sim = new Simulation(world, [model]);
    let last = 0;
    for (let k = 0; k < 6; k++) {
      sim.run(20, 1);
      const now = burnedCells(world);
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    expect(last).toBeGreaterThan(100);
  });

  it('an oblique wind sends the fire the way the wind points, SIGNED', () => {
    // The gate the whole §7 table is blind to. Wind 30° above +x on screen —
    // i.e. (cos30, −sin30), because screen y grows downward. A mirrored ellipse
    // would send the head to −30° with every magnitude unchanged.
    const theta = Math.PI / 6;
    const WIND = 3;
    const steps = 200;
    const world = pointIgnition(121, steps, 40, WIND);
    runHuygens(world, steps, new UniformWeatherProvider(WIND * Math.cos(theta), -WIND * Math.sin(theta)));

    const cx = world.width >> 1;
    const cy = world.height >> 1;
    let best = -1;
    let bx = 0;
    let by = 0;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (world.layers.fire.get(x, y) === FireState.Unburned) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d > best) {
          best = d;
          bx = x - cx;
          by = y - cy;
        }
      }
    }
    // atan2(−by, bx) puts the answer back in the reader's frame (up is positive).
    const measuredDeg = (Math.atan2(-by, bx) * 180) / Math.PI;
    expect(measuredDeg).toBeGreaterThan(20);
    expect(measuredDeg).toBeLessThan(40);
  });
});

describe('Huygens marker front — rate and shape', () => {
  it('a windless fire spreads at the analytic Rothermel R₀ in every direction', () => {
    // The `spread-ros` gate, on this path. The raster version measures a planar
    // front because its accumulators are exact only along rays; a marker front
    // has no rays, so the sharper claim is available: the radius is R₀·t at
    // *every* angle, which is both the rate check and the isotropy check.
    const steps = 240;
    const target = 30;
    const world = pointIgnition(91, steps, target, 0);
    const model = new HuygensFireModel(new Anderson13FuelModel());
    new Simulation(world, [model]).run(steps, 1);

    const rs: number[] = [];
    for (let k = 0; k < 32; k++) {
      const a = (2 * Math.PI * k) / 32;
      rs.push(radius(world, Math.cos(a), Math.sin(a)));
    }
    // Read off the `fire` layer, so this carries the grid's ±1-cell quantisation:
    // at a 30-cell radius one cell is 3 %, and a max/min over 32 rays picks that
    // up twice. The raster front measures 1.080 on exactly this run, so the
    // marker front's 1.04 is real but is NOT the interesting number.
    expect(Math.max(...rs) / Math.min(...rs)).toBeLessThan(1.06);
    // …and the radius itself is the analytic one. The seed ring starts at half a
    // cell, so the fire is that much ahead of a true point ignition; the ±1-cell
    // counting floor is the other side of the tolerance.
    for (const r of rs) {
      expect(r / target).toBeGreaterThan(0.94);
      expect(r / target).toBeLessThan(1.10);
    }

    // The interesting number: the FRONT, which the model still holds as a
    // polygon, free of the grid it gets painted onto. This is the claim Phase 11
    // actually makes — the raster front's floor is a 16-gon inscribed in the true
    // circle (1.087 max/min, 0.940 of the due-east radius at 11.25°, `docs/science.md`
    // §9) and a marker front has no such floor at all.
    const ring = model.perimeters[0];
    const cx = (world.width >> 1) + 0.5;
    const cy = (world.height >> 1) + 0.5;
    let lo = Infinity;
    let hi = -Infinity;
    let at0 = 0;
    let at1125 = 0;
    for (let k = 0; k < ring.xs.length; k++) {
      const dx = ring.xs[k] - cx;
      const dy = ring.ys[k] - cy;
      const r = Math.hypot(dx, dy);
      if (r < lo) lo = r;
      if (r > hi) hi = r;
      const deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
      if (Math.abs(deg) < 1.5) at0 = r;
      if (Math.abs(deg - 11.25) < 1.5) at1125 = r;
    }
    expect(hi / lo).toBeLessThan(1.01);
    expect(at1125 / at0).toBeGreaterThan(0.99);
  });

  it('a wind-driven fire is longer than it is wide, and backs at the backing rate', () => {
    const WIND = 3;
    const steps = 200;
    const world = pointIgnition(161, steps, 45, WIND);
    runHuygens(world, steps, new UniformWeatherProvider(WIND, 0));

    const head = radius(world, 1, 0);
    const back = radius(world, -1, 0);
    const flank = (radius(world, 0, 1) + radius(world, 0, -1)) / 2;
    expect(head).toBeGreaterThan(flank * 1.5);
    expect(flank).toBeGreaterThan(back); // the flank is wide, not the back
    expect(back).toBeGreaterThan(0); // …but the fire does back into the wind
  });
});

describe('Huygens marker front — a barrier is still a barrier', () => {
  it('a nonburnable line stops the front, and a one-cell gap in it leaks', () => {
    // The Phase-4 containment doctrine, on this path. A marker advancing R·dt
    // unchecked would step clean over a one-cell cut; the substep cap plus the
    // fuel test at the marker's new position is what stops it (§D4).
    const steps = 300;
    const target = 24;
    const barrierX = 55; // ~14 cells right of the centre of a 81-wide map

    const build = (gap: boolean): WorldState => {
      const world = pointIgnition(81, steps, target, 0);
      for (let y = 0; y < world.height; y++) {
        if (gap && y === world.height >> 1) continue;
        world.layers.fuel.set(barrierX, y, Fuel.Nonburnable);
      }
      return world;
    };

    const sealed = build(false);
    runHuygens(sealed, steps);
    let beyond = 0;
    for (let y = 0; y < sealed.height; y++) {
      for (let x = barrierX; x < sealed.width; x++) {
        if (sealed.layers.fire.get(x, y) !== FireState.Unburned) beyond++;
      }
    }
    expect(beyond).toBe(0);

    const leaky = build(true);
    runHuygens(leaky, steps);
    let through = 0;
    for (let y = 0; y < leaky.height; y++) {
      for (let x = barrierX + 1; x < leaky.width; x++) {
        if (leaky.layers.fire.get(x, y) !== FireState.Unburned) through++;
      }
    }
    expect(through).toBeGreaterThan(0);
  });
});

describe('Huygens marker front — the layers the rest of the sim reads', () => {
  it('every burning cell carries a defined fireline intensity', () => {
    // §5c's first check: nothing may be swallowed at zero. Spotting and the crown
    // thresholds read this layer, and a zero there is silently "no fire".
    const steps = 150;
    const world = pointIgnition(61, steps, 18, 2);
    runHuygens(world, steps, new UniformWeatherProvider(2, 0));
    let checked = 0;
    for (let i = 0; i < world.layers.fire.data.length; i++) {
      if (world.layers.fire.data[i] === FireState.Unburned) continue;
      expect(world.layers.intensity.data[i]).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('cells lit by a flank run cooler than cells lit at the head', () => {
    // §5c's second check, and the thing a raster front cannot say at all: under a
    // sweeping front, intensity is a property of the *segment* that covered the
    // cell, so a flank segment is genuinely cooler than the head. Getting this
    // wrong shifts crown initiation and ember production with nothing erroring.
    const WIND = 4;
    const steps = 200;
    const world = pointIgnition(161, steps, 45, WIND);
    runHuygens(world, steps, new UniformWeatherProvider(WIND, 0));

    const cx = world.width >> 1;
    const cy = world.height >> 1;
    const at = (x: number, y: number): number => world.layers.intensity.data[y * world.width + x];
    const headR = Math.floor(radius(world, 1, 0));
    const flankR = Math.floor(radius(world, 0, -1));
    expect(headR).toBeGreaterThan(4);
    expect(flankR).toBeGreaterThan(2);
    // Sample a few cells just inside each extremity rather than the single
    // furthest one, so the comparison is not riding on one boundary cell.
    const headI = (at(cx + headR - 1, cy) + at(cx + headR - 2, cy)) / 2;
    const flankI = (at(cx, cy - flankR + 1) + at(cx, cy - flankR + 2)) / 2;
    expect(headI).toBeGreaterThan(flankI * 1.2);
  });
});

describe('Huygens marker front — wired into the scenario pipeline', () => {
  it("`spreadEngine: 'huygens'` builds the marker front and its fire grows", () => {
    // The only check that the loader actually reaches this model — every preset
    // ships on `'raster'`, so nothing else would notice if the wiring rotted.
    // Spotting is off: it throws concurrent perimeters, which needs Stage 2's
    // merging, and this is a wiring test rather than a behaviour one.
    const base = findPreset('grass-valley')!;
    const l = loadScenario({
      ...base,
      width: 64,
      height: 64,
      spreadEngine: 'huygens',
      spotting: false,
      agents: undefined,
      ignitions: 'center',
    });
    expect(l.systems.some((s) => s.name === 'fire:huygens')).toBe(true);
    l.sim.run(600, 1);
    let touched = 0;
    for (const v of l.world.layers.fire.data) if (v !== FireState.Unburned) touched++;
    expect(touched).toBeGreaterThan(3);
  });
});

describe('Huygens marker front — determinism', () => {
  it('the same scenario twice is byte-for-byte the same run', () => {
    // §D9. The raster front sweeps cells in index order, which is a total order
    // for free; a marker front is not automatically ordered, so the ordering
    // rules (rings in creation order, points in ring order, the seeding scan in
    // cell-index order) are a design decision that needs pinning rather than an
    // accident of the loop. Same shape as the `timber-crown-run` golden, but
    // self-comparing: this pins the *property*, not a particular number, so it
    // does not have to be recomputed every time the model legitimately changes.
    const base = findPreset('grass-valley')!;
    const once = (): number => {
      const l = loadScenario({
        ...base,
        width: 64,
        height: 64,
        spreadEngine: 'huygens',
        spotting: false,
        agents: undefined,
        ignitions: 'center',
      });
      l.sim.run(400, 1);
      const { fire, intensity, crown } = l.world.layers;
      let h = 0x811c9dc5; // FNV-1a
      const mix = (v: number): void => {
        h ^= v & 0xff;
        h = Math.imul(h, 0x01000193);
      };
      for (let i = 0; i < fire.data.length; i++) mix(fire.data[i]);
      for (let i = 0; i < intensity.data.length; i++) {
        const kw = Math.round(intensity.data[i]);
        mix(kw);
        mix(kw >>> 8);
        mix(kw >>> 16);
      }
      for (let i = 0; i < crown.data.length; i++) mix(crown.data[i]);
      return h >>> 0;
    };
    const a = once();
    expect(once()).toBe(a);
    // …and the run actually did something, so the hash is not of an empty map.
    expect(a).not.toBe(0x811c9dc5);
  });
});
