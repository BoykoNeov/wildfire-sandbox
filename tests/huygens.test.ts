import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import type { System } from '../src/core/system';
import { Anderson13FuelModel, ANDERSON_13, deadFuelBed } from '../src/sim/anderson13';
import { HuygensFireModel } from '../src/sim/huygensFireModel';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import type { IFireModel } from '../src/models/IFireModel';
import { SpottingSystem } from '../src/sim/spottingSystem';
import { UniformWeatherProvider } from '../src/sim/uniformWeather';
import { Fuel } from '../src/sim/basicFuelModel';
import { TerrainFuelModel } from '../src/sim/terrainFuelModel';
import { segmentCross, selfIntersects, type Crossing, type Ring } from '../src/sim/perimeter';
import { surfaceSpread, ftPerMinToMetersPerSec, metersPerSecToFtPerMin } from '../src/sim/rothermel';
import { byteToFraction, fractionToByte } from '../src/core/moisture';
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

/**
 * A flat homogeneous field lit at two points `apart` cells either side of centre,
 * sized so each head travels ~`travel` cells in `steps` ticks — chosen so the two
 * fires overlap well before the run ends.
 */
function twoIgnition(size: number, steps: number, travel: number, apart: number): WorldState {
  const cellSize = (analyticHeadMps(0) * steps) / travel;
  const world = createWorld({ width: size, height: size, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST);
  const cy = size >> 1;
  world.layers.fire.set((size >> 1) - (apart >> 1), cy, FireState.Burning);
  world.layers.fire.set((size >> 1) + (apart >> 1), cy, FireState.Burning);
  return world;
}

describe('Huygens marker front — two perimeters merge (Stage 2, §D6)', () => {
  it('two fronts that grow together weld into one burn with no cold seam', () => {
    // The heart of Stage 2. Two separate ignitions each seed their own perimeter;
    // as they grow together the markers of one step onto ground the other owns and
    // stop there, so the fires join instead of burning through each other. The
    // discriminator is the lens between them: if the weld worked, the whole
    // segment joining the two ignition points is burned — no unburned seam — and
    // every cell of it carries a real intensity (nothing swallowed at zero, §5c).
    const size = 121;
    const steps = 240;
    const apart = 16;
    const world = twoIgnition(size, steps, 22, apart);
    const model = new HuygensFireModel(new Anderson13FuelModel());
    new Simulation(world, [model]).run(steps, 1);

    const cy = size >> 1;
    const left = (size >> 1) - (apart >> 1);
    const right = (size >> 1) + (apart >> 1);
    for (let x = left; x <= right; x++) {
      expect(world.layers.fire.get(x, cy)).not.toBe(FireState.Unburned);
    }
    // Every burning cell — including the swept-together lens — has a defined intensity.
    let burning = 0;
    for (let i = 0; i < world.layers.fire.data.length; i++) {
      if (world.layers.fire.data[i] === FireState.Unburned) continue;
      expect(world.layers.intensity.data[i]).toBeGreaterThan(0);
      burning++;
    }
    // …and the merged burn is a sane size (two overlapping disks), not an explosion.
    expect(burning).toBeGreaterThan(200);
    expect(burning).toBeLessThan(size * size);
  });

  it('a front enclosed by burnt/nonburnable ground is retired (cost bound, §D6)', () => {
    // The cost half of merging: a ring with nowhere left to grow must be dropped,
    // or it recomputes an outward push forever. A small burnable field boxed in by
    // nonburnable fuel is the cleanest case — the fire fills the interior, then
    // every marker is against the box and the front is retired, leaving the
    // interior fully burned. (In dense spotting the same mechanism retires a spot
    // fire the main burn has grown all the way around.)
    const size = 31;
    const steps = 400;
    const cellSize = (analyticHeadMps(0) * steps) / 40; // head crosses the field well within the run
    const world = createWorld({ width: size, height: size, seed: 1, cellSize });
    world.layers.fuel.data.fill(Fuel.Nonburnable);
    // A burnable interior box [8, 23) with a nonburnable frame around it.
    for (let y = 8; y < 23; y++) {
      for (let x = 8; x < 23; x++) {
        world.layers.fuel.set(x, y, FM);
        world.layers.moisture.set(x, y, MOIST);
      }
    }
    world.layers.fire.set(size >> 1, size >> 1, FireState.Burning);
    const model = new HuygensFireModel(new Anderson13FuelModel());
    const sim = new Simulation(world, [model]);

    let peak = 0;
    for (let k = 0; k < 20; k++) {
      sim.run(steps / 20, 1);
      peak = Math.max(peak, model.perimeters.length);
    }
    // The front had a life and then ended it: at least one existed, and by the end
    // — the interior full, every marker jammed against the frame — none remain.
    expect(peak).toBeGreaterThan(0);
    expect(model.perimeters.length).toBe(0);
    // Retirement did not un-burn: the burnable interior is (almost) all alight.
    let interiorBurnt = 0;
    for (let y = 8; y < 23; y++) {
      for (let x = 8; x < 23; x++) {
        if (world.layers.fire.get(x, y) !== FireState.Unburned) interiorBurnt++;
      }
    }
    expect(interiorBurnt).toBeGreaterThan(15 * 15 * 0.9);
  });
});

describe('Huygens marker front — spotting throws concurrent perimeters (Stage 2, §D6)', () => {
  it('embers ignite across a firebreak, and the many fronts stay bounded and finite', () => {
    // Gate 2 on this path. The spotting scenario is the reason Stage 2 exists: a
    // sustained front parked at a nonburnable break throws embers downwind, each
    // landing an independent ignition the marker model must seed, grow and merge.
    // Surface spread cannot cross the break, so any far-side fire is an ember —
    // and the run must stay well-formed (no NaN, front count bounded by retirement).
    const W = 40;
    const H = 13;
    const FM_TIMBER = 10;
    const DRY = 10;
    const CANOPY = 200;
    const WIND_EAST = 12;
    const GAP_START = 20;
    const GAP_END = 24;
    const SOURCE_COLS = [16, 17, 18, 19];

    const world = createWorld({ width: W, height: H, seed: 7, cellSize: 30 });
    world.layers.fuel.data.fill(FM_TIMBER);
    world.layers.moisture.data.fill(DRY);
    world.layers.canopy.data.fill(CANOPY);
    world.layers.windU.data.fill(WIND_EAST);
    for (let y = 0; y < H; y++) {
      for (let x = GAP_START; x < GAP_END; x++) {
        world.layers.fuel.set(x, y, Fuel.Nonburnable);
        world.layers.canopy.set(x, y, 0);
      }
    }

    const fuel = new Anderson13FuelModel();
    const model = new HuygensFireModel(fuel);
    const sim = new Simulation(world, [model, new SpottingSystem(fuel)]);
    let nan = 0;
    let maxFronts = 0;
    for (let s = 0; s < 150; s++) {
      for (const x of SOURCE_COLS) {
        for (let y = 0; y < H; y++) {
          world.layers.fire.set(x, y, FireState.Burning);
          world.layers.burnElapsed.data[y * W + x] = 0;
        }
      }
      sim.step(1);
      maxFronts = Math.max(maxFronts, model.perimeters.length);
      for (const r of model.perimeters) for (const v of r.xs) if (!Number.isFinite(v)) nan++;
    }

    let farside = 0;
    for (let y = 0; y < H; y++) {
      for (let x = GAP_END; x < W; x++) {
        if (world.layers.fire.get(x, y) !== FireState.Unburned) farside++;
      }
    }
    expect(farside).toBeGreaterThan(0); // embers crossed
    expect(nan).toBe(0); // the fronts stayed well-formed
    expect(maxFronts).toBeLessThan(W * H); // and bounded — retirement kept a lid on it
  });
});

describe('Huygens marker front — a cut line still holds under merging (Stage 2, Gate 1)', () => {
  it('a one-cell CutLine holds a planar multi-front ignition; a gap in it leaks', () => {
    // Suppression on this path. A whole-column ignition seeds a *row* of separate
    // perimeters that grow east and merge into one planar front — so this is a
    // merge stress test as well as the Phase-4 containment doctrine. The line is a
    // single CutLine column (nonburnable via TerrainFuelModel); the substep cap
    // plus the fuel test at each marker's new position is what stops a marker from
    // stepping over it, exactly as for the raster front's supercover gate.
    const W = 48;
    const H = 13;
    const DRY = 10;
    const WIND_EAST = 6;
    const LINE_X = 24;

    const build = (gap: boolean): WorldState => {
      const world = createWorld({ width: W, height: H, seed: 1, cellSize: 30 });
      world.layers.fuel.data.fill(Fuel.Grass);
      world.layers.moisture.data.fill(DRY);
      world.layers.windU.data.fill(WIND_EAST);
      for (let y = 0; y < H; y++) world.layers.fire.set(0, y, FireState.Burning);
      for (let y = 0; y < H; y++) {
        if (gap && y === H >> 1) continue;
        world.layers.fuel.set(LINE_X, y, Fuel.CutLine);
      }
      return world;
    };

    const farIgnited = (world: WorldState, x0: number): number => {
      let n = 0;
      for (let y = 0; y < H; y++) for (let x = x0; x < W; x++) {
        if (world.layers.fire.get(x, y) !== FireState.Unburned) n++;
      }
      return n;
    };

    const sealed = build(false);
    new Simulation(sealed, [new HuygensFireModel(new TerrainFuelModel())]).run(400, 1);
    expect(farIgnited(sealed, LINE_X - 1)).toBeGreaterThan(0); // the front arrived…
    expect(farIgnited(sealed, LINE_X + 1)).toBe(0); // …and nothing crossed the line

    const leaky = build(true);
    new Simulation(leaky, [new HuygensFireModel(new TerrainFuelModel())]).run(400, 1);
    expect(farIgnited(leaky, LINE_X + 1)).toBeGreaterThan(0); // one gap and it gets through
  });
});

describe('Huygens marker front — the spotting preset runs a simulated hour (Stage 2, §D6)', () => {
  it('timber-crown-run steps a full hour without a degenerate or runaway perimeter', () => {
    // The Stage 2 acceptance run. `timber-crown-run` carries multiple concurrent
    // perimeters from its first ember, so it exercises seeding, merging and
    // retirement together for a simulated hour. The gate is that it stays healthy:
    // it completes, the fire grows, every burning cell has a defined intensity,
    // no marker goes non-finite, and the front count stays bounded (retirement
    // holds it well under one-front-per-cell).
    const base = findPreset('timber-crown-run')!;
    const SZ = 64;
    // The preset's ignition and crew/engine/aircraft coordinates are absolute to
    // its 256² map; on a 64² test map they fall off the edge, so ignite at centre
    // and drop the (off-map) agents. Spotting stays on — it is the whole point,
    // and what makes this the multi-perimeter Stage 2 run.
    const l = loadScenario({
      ...base,
      width: SZ,
      height: SZ,
      spreadEngine: 'huygens',
      ignitions: 'center',
      agents: undefined,
    });
    const model = l.systems.find((s) => s.name === 'fire:huygens') as HuygensFireModel;
    l.sim.run(3600, 1); // one simulated hour at dt = 1 s

    let burned = 0;
    let zeroInt = 0;
    let nan = 0;
    for (let i = 0; i < l.world.layers.fire.data.length; i++) {
      if (l.world.layers.fire.data[i] === FireState.Unburned) continue;
      burned++;
      if (l.world.layers.intensity.data[i] <= 0) zeroInt++;
    }
    for (const r of model.perimeters) for (const v of r.xs) if (!Number.isFinite(v)) nan++;
    expect(burned).toBeGreaterThan(300);
    expect(nan).toBe(0);
    // Every burning cell carries a defined intensity — bar at most a handful of
    // embers `SpottingSystem` lit *this* very tick (it runs after the fire model,
    // so their intensity is only filled on the next tick's step-1 fallback). This
    // was verified, not assumed: at the end of the hour exactly one cell read zero,
    // and one more `HuygensFireModel.step` cleared it — so it is a same-tick ember,
    // not a permanently-wet cell the fallback keeps zeroing. The no-cell-swallowed
    // -at-zero invariant (§5c) is pinned deterministically by the two-front weld
    // test, which has no spotting.
    expect(zeroInt).toBeLessThanOrEqual(5);
    // Bounded, and non-vacuously so: the measured hour ends with 29 live fronts
    // (173 with retirement off), so this is well above the real count and far below
    // one-front-per-cell. The next test pins what retirement buys exactly.
    expect(model.perimeters.length).toBeLessThan(100);
    // …and every front is simple at the end of the hour: crossover removal (§D7)
    // left no residual tangle. (The every-tick guarantee is pinned on the island
    // gate above; here the end-state check is the cheap catch-all on a full run,
    // where without removal the detector finds hundreds of crossings.)
    expect(totalSelfX(model)).toBe(0);
  }, 60_000);

  it('retirement never changes what burns — only what it costs', () => {
    // A front is retired when it has no open move, or when nothing burnable is
    // left within reach of any of its markers (`HuygensFireModel.hasFrontier`).
    // Both are meant to be pure cost savings, so the same hour with retirement
    // switched off must paint `fire`, `intensity` and `crown` **identically, cell
    // for cell**. The suppression orders are the ones `tools/profile.ts` issues —
    // they are what make this run sensitive: with a one-cell frontier reach, three
    // fronts on it looked dead, later reached an unburned cell two cells off, and
    // retiring them left 27 cells unburned. Two cells is the measured reach.
    const base = findPreset('timber-crown-run')!;
    const SZ = 64;
    const run = (retire: boolean): { l: ReturnType<typeof loadScenario>; model: HuygensFireModel } => {
      const l = loadScenario({
        ...base,
        width: SZ,
        height: SZ,
        spreadEngine: 'huygens',
        ignitions: 'center',
        fireModel: { ...base.fireModel, retire },
      });
      const c = SZ >> 1;
      if (l.crew) for (let y = c - 40; y < c + 40; y++) l.crew.orderCutLine(c + 24, y);
      l.engine?.orderDirectAttack(c + 8, c + 30);
      l.aircraft?.orderRetardantDrop(c + 30, c - 24);
      l.sim.run(3600, 1);
      return { l, model: l.systems.find((s) => s.name === 'fire:huygens') as HuygensFireModel };
    };
    const on = run(true);
    const off = run(false);
    const a = on.l.world.layers;
    const b = off.l.world.layers;
    let differ = 0;
    for (let i = 0; i < a.fire.data.length; i++) {
      if (a.fire.data[i] !== b.fire.data[i] || a.intensity.data[i] !== b.intensity.data[i] || a.crown.data[i] !== b.crown.data[i]) differ++;
    }
    expect(differ).toBe(0);
    // …and it is doing real work, not passing vacuously: measured 53 live fronts /
    // 1 703 markers at the end of the hour, against 176 / 6 054 with it off. (With
    // a one-cell reach this test fails: 443 cells differ.)
    expect(on.model.perimeters.length * 2).toBeLessThan(off.model.perimeters.length);
  }, 120_000);
});

describe('Huygens marker front — a temporarily unburnable cell is not a permanent one', () => {
  it('the whole field going wet stalls the fire without retiring it; it resumes on drydown', () => {
    // The blocking bug the advisor caught: `step()` clears every front's `open`
    // flag, then breaks out of the substep loop before `advance` runs on a tick
    // where no marker has any speed — so retiring on "no open move" would drop
    // *every* fire the moment the field goes wet (a rain pulse, marginal
    // moisture), and since the cells stay owned nothing re-seeds: the fire is dead
    // for good. Retirement must skip a tick where `advance` never ran.
    const size = 41;
    const world = pointIgnition(size, 240, 24, 0); // dry FM1, head travels 24 cells in 240 ticks
    const model = new HuygensFireModel(new Anderson13FuelModel());
    const sim = new Simulation(world, [model]);

    sim.run(60, 1); // establish a small fire
    const established = burnedCells(world);
    expect(established).toBeGreaterThan(4);
    expect(model.perimeters.length).toBeGreaterThan(0);

    // Soak the whole field above FM1's extinction moisture (~12%).
    world.layers.moisture.data.fill(fractionToByte(0.25));
    sim.run(40, 1);
    expect(model.perimeters.length).toBeGreaterThan(0); // the fire is NOT retired…
    expect(burnedCells(world)).toBe(established); // …and did not spread while wet

    // Dry it back out — the front is still there and picks up where it left off.
    world.layers.moisture.data.fill(MOIST);
    sim.run(140, 1);
    expect(burnedCells(world)).toBeGreaterThan(established);
  });

  it('a wet band stops the front, and the front crosses once the band dries (item 4)', () => {
    // The suppression drydown case on this path. Painting checks fuel id, but a
    // wet or retardant-pinned cell is burnable fuel Rothermel gives a zero rate —
    // so without the moisture gate a marker steps straight over the band the
    // raster front stalls at. (Retardant suppresses by re-pinning `moisture`, the
    // very layer this gate reads, so it is covered by the same code path.)
    const size = 61;
    const world = pointIgnition(size, 200, 20, 0);
    const cx = size >> 1;
    const cy = size >> 1;
    const bandX = cx + 6;
    const wet = fractionToByte(0.25); // above FM1 extinction
    for (let y = 0; y < size; y++) {
      world.layers.moisture.set(bandX, y, wet);
      world.layers.moisture.set(bandX + 1, y, wet);
    }
    const model = new HuygensFireModel(new Anderson13FuelModel());
    const sim = new Simulation(world, [model]);

    sim.run(140, 1);
    const eastOfBand = (w: WorldState): number => {
      let n = 0;
      for (let y = 0; y < size; y++) for (let x = bandX + 2; x < size; x++) {
        if (w.layers.fire.get(x, y) !== FireState.Unburned) n++;
      }
      return n;
    };
    expect(world.layers.fire.get(bandX - 1, cy)).not.toBe(FireState.Unburned); // reached the band
    expect(eastOfBand(world)).toBe(0); // …but did not cross it while wet

    // Dry the band; the front that was held at it now crosses.
    for (let y = 0; y < size; y++) {
      world.layers.moisture.set(bandX, y, MOIST);
      world.layers.moisture.set(bandX + 1, y, MOIST);
    }
    sim.run(160, 1);
    expect(eastOfBand(world)).toBeGreaterThan(0);
  });
});

describe('Huygens marker front — retirement fires on envelopment, and it is what it costs (Stage 2)', () => {
  /** A dry all-burnable field, a spot lit at centre, ringed by a box of ignitions. */
  function ringAroundSpot(size: number, steps: number, retire: boolean): { world: WorldState; model: HuygensFireModel; sim: Simulation } {
    const cellSize = (analyticHeadMps(0) * steps) / 18;
    const world = createWorld({ width: size, height: size, seed: 3, cellSize });
    world.layers.fuel.data.fill(FM);
    world.layers.moisture.data.fill(MOIST);
    const c = size >> 1;
    world.layers.fire.set(c, c, FireState.Burning); // the spot to be enveloped
    const r = 6;
    for (let d = -r; d <= r; d++) {
      world.layers.fire.set(c + d, c - r, FireState.Burning);
      world.layers.fire.set(c + d, c + r, FireState.Burning);
      world.layers.fire.set(c - r, c + d, FireState.Burning);
      world.layers.fire.set(c + r, c + d, FireState.Burning);
    }
    const model = new HuygensFireModel(new Anderson13FuelModel(), { retire });
    return { world, model, sim: new Simulation(world, [model]) };
  }

  it('a front enclosed by ANOTHER front’s burnt ground is retired — no barrier involved', () => {
    // The case Stage 2 exists for, which the nonburnable-box test does not reach:
    // the centre spot is walled off not by rock but by the surrounding fires' own
    // burnt ground, so every one of its markers steps onto another front's cell
    // and it is retired. There is no nonburnable fuel anywhere, so envelopment is
    // the only thing that could have retired it.
    const size = 41;
    const steps = 300;
    const { world, model, sim } = ringAroundSpot(size, steps, true);
    let peak = 0;
    for (let k = 0; k < 20; k++) {
      sim.run(steps / 20, 1);
      peak = Math.max(peak, model.perimeters.length);
    }
    let nonburnable = 0;
    for (const v of world.layers.fuel.data) if (v === Fuel.Nonburnable) nonburnable++;
    expect(nonburnable).toBe(0);
    expect(peak).toBeGreaterThan(model.perimeters.length); // some front was retired
  });

  it('retirement lowers the live front and marker counts (the cost it buys, item 2)', () => {
    // The on/off baseline: the same envelopment scenario with retirement disabled
    // keeps the swallowed rings, so it ends with strictly more live fronts and
    // markers — and the burned area is identical, because retirement never touches
    // output. This is the mechanism behind the measured hour (140 vs 164 fronts,
    // 5302 vs 6128 markers at 64²).
    const size = 41;
    const steps = 300;
    const on = ringAroundSpot(size, steps, true);
    const off = ringAroundSpot(size, steps, false);
    on.sim.run(steps, 1);
    off.sim.run(steps, 1);
    const markers = (m: HuygensFireModel): number => m.perimeters.reduce((s, r) => s + r.xs.length, 0);
    expect(on.model.perimeters.length).toBeLessThan(off.model.perimeters.length);
    expect(markers(on.model)).toBeLessThan(markers(off.model));
    const burned = (w: WorldState): number => {
      let n = 0;
      for (const v of w.layers.fire.data) if (v !== FireState.Unburned) n++;
      return n;
    };
    expect(burned(on.world)).toBe(burned(off.world)); // identical output
  });
});

/** Count non-adjacent segment pairs of a ring that properly cross (self-intersections). */
function selfIntersections(ring: Ring): number {
  const { xs, ys } = ring;
  const n = xs.length;
  const out: Crossing = { x: 0, y: 0 };
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n;
    for (let j = i + 1; j < n; j++) {
      const c = j, d = (j + 1) % n;
      if (a === c || a === d || b === c || b === d) continue; // adjacent/shared vertex
      if (segmentCross(xs[a], ys[a], xs[b], ys[b], xs[c], ys[c], xs[d], ys[d], out)) count++;
    }
  }
  return count;
}

/** Total self-intersections across all of a model's fronts. */
function totalSelfX(model: HuygensFireModel): number {
  let n = 0;
  for (const r of model.perimeters) n += selfIntersections(r);
  return n;
}
function totalMarkers(model: HuygensFireModel): number {
  let n = 0;
  for (const r of model.perimeters) n += r.xs.length;
  return n;
}

/** A field with a nonburnable island centred on the ignition row (wind, if any, via a provider). */
function islandWorld(): { world: WorldState; ix1: number; cy: number } {
  const size = 81;
  const steps = 150;
  const cellSize = (analyticHeadMps(0) * steps) / 26;
  const world = createWorld({ width: size, height: size, seed: 1, cellSize });
  world.layers.fuel.data.fill(FM);
  world.layers.moisture.data.fill(MOIST);
  const cy = size >> 1;
  const igx = cy - 12;
  const ix0 = cy - 4, ix1 = cy + 4, iy0 = cy - 5, iy1 = cy + 5;
  for (let y = iy0; y < iy1; y++) for (let x = ix0; x < ix1; x++) world.layers.fuel.set(x, y, Fuel.Nonburnable);
  world.layers.fire.set(igx, cy, FireState.Burning);
  return { world, ix1, cy };
}

function burnedCount(w: WorldState): number {
  let n = 0;
  for (const v of w.layers.fire.data) if (v !== FireState.Unburned) n++;
  return n;
}

describe('Huygens marker front — self-crossings are removed (Stage 3, §D7)', () => {
  it('a front wrapping a nonburnable island stays simple, at the same burned area', () => {
    // The case §D7 names. A circular front centred to wrap the island, its two
    // lips meeting head-on behind it — the geometry that folds the perimeter onto
    // itself. Under wind the fold is violent: without removal the ring reaches
    // ~15 000 crossings and the marker count runs away (measured 9.3 M before this
    // was fixed to keep only the outer loop). The gate: decross OFF really does
    // tangle (non-vacuous), decross ON leaves every front simple, the marker count
    // stays bounded, and the burned area is unchanged to within a few cells —
    // because dropping the folded ear un-burns nothing.
    for (const wind of [0, 3]) {
      const on = islandWorld();
      const off = islandWorld();
      const mOn = new HuygensFireModel(new Anderson13FuelModel(), { decross: true });
      const mOff = new HuygensFireModel(new Anderson13FuelModel(), { decross: false });
      const sOn = new Simulation(on.world, wind > 0 ? [new UniformWeatherProvider(wind, 0), mOn] : [mOn]);
      const sOff = new Simulation(off.world, wind > 0 ? [new UniformWeatherProvider(wind, 0), mOff] : [mOff]);
      // Check the decrossed model's simplicity EVERY tick (with the model's own
      // predicate, so the test and the model agree on what a crossing is) — a loop
      // can form and be gone between coarse samples. The un-removed model is checked
      // *during* the run too, not at the end: under wind the fire burns the whole
      // map, and once nothing is left to burn every front — tangled or not — is
      // correctly retired, so an end-of-run check would see no fronts at all.
      let offTangled = false;
      let peakOn = 0;
      let peakOff = 0;
      for (let t = 0; t < 150; t++) {
        sOn.step(1);
        sOff.step(1);
        expect(mOn.perimeters.some((r) => selfIntersects(r))).toBe(false); // ON: simple every tick
        offTangled ||= mOff.perimeters.some((r) => selfIntersects(r));
        peakOn = Math.max(peakOn, totalMarkers(mOn));
        peakOff = Math.max(peakOff, totalMarkers(mOff));
      }

      expect(on.world.layers.fire.get(on.ix1 + 2, on.cy)).not.toBe(FireState.Unburned); // lips met
      expect(offTangled).toBe(true); // the scenario really tangles without removal…
      expect(peakOn).toBeLessThanOrEqual(peakOff); // markers bounded
      expect(Math.abs(burnedCount(on.world) - burnedCount(off.world))).toBeLessThanOrEqual(8); // area unchanged
    }
  }, 30_000);

  it('a wind-driven fold does not blow up the marker count', () => {
    // The runaway this stage exists to stop, stated as a hard bound: with removal
    // the windy island holds ~1 000 markers; without it, ~12 000 and climbing.
    // Measured over the run, not at its end: this fire burns the whole map, and
    // once nothing is left every front is (correctly) retired, so an end-of-run
    // count would be of an empty model.
    const { world, ix1, cy } = islandWorld();
    const model = new HuygensFireModel(new Anderson13FuelModel(), { decross: true });
    const sim = new Simulation(world, [new UniformWeatherProvider(3, 0), model]);
    let peak = 0;
    let everCrossed = false;
    for (let t = 0; t < 150; t++) {
      sim.step(1);
      peak = Math.max(peak, totalMarkers(model));
      everCrossed ||= model.perimeters.some((r) => selfIntersects(r));
    }
    expect(world.layers.fire.get(ix1 + 2, cy)).not.toBe(FireState.Unburned);
    expect(peak).toBeGreaterThan(100); // non-vacuous: there was a front to bound
    expect(peak).toBeLessThan(3000);
    expect(everCrossed).toBe(false);
  }, 30_000);
});

/**
 * The {@link islandWorld} geometry with the island WET (above FM1 extinction)
 * instead of rock, burned past until the rim is out; then the island is dried and
 * one ember is dropped on a cell the front **claimed but never lit**, and the run
 * continues. Returns how many island cells are still unburned, plus the setup facts
 * that make that number mean something.
 */
function wetIslandEmber(engine: 'huygens' | 'raster'): {
  claimedUnlit: number;
  emberCellClaimed: boolean;
  stillUnburned: number;
} {
  const { world, ix1, cy } = islandWorld();
  const fuel = world.layers.fuel.data;
  const moist = world.layers.moisture.data;
  const island: number[] = [];
  for (let i = 0; i < fuel.length; i++) {
    if (fuel[i] === Fuel.Nonburnable) {
      fuel[i] = FM;
      moist[i] = fractionToByte(0.25);
      island.push(i);
    }
  }
  const model: IFireModel =
    engine === 'huygens' ? new HuygensFireModel(new Anderson13FuelModel()) : new RothermelFireModel(new Anderson13FuelModel());
  const sim = new Simulation(world, [model]);
  sim.run(400, 1); // the front wraps the island, its lips meet behind it, and the rim burns out
  expect(world.layers.fire.get(ix1 + 2, cy)).not.toBe(FireState.Unburned);

  const fire = world.layers.fire.data;
  const owner = engine === 'huygens' ? (model as unknown as { owner: Int32Array }).owner : null;
  const claimed = island.filter((i) => fire[i] === FireState.Unburned && owner !== null && owner[i] >= 0);
  // The raster has no ownership: its ember goes on the island's centre instead.
  const ember = claimed[0] ?? cy * world.width + (ix1 - 4);

  for (const i of island) moist[i] = MOIST; // the island dries…
  fire[ember] = FireState.Burning; // …and an ember lands in it
  sim.run(300, 1);
  return {
    claimedUnlit: claimed.length,
    emberCellClaimed: claimed.includes(ember),
    stillUnburned: island.filter((i) => fire[i] === FireState.Unburned).length,
  };
}

describe('Huygens marker front — a wet cell the front touched but did not light (known bug)', () => {
  // The paint in `advance` sets `owner[i]` BEFORE it checks `carriesFire`, so a
  // front edge that sweeps across a wet (or retardant-pinned) cell claims it without
  // lighting it — here, the island's corners. Two things read that claim later:
  // seeding (`owner[i] < 0` only), so an ember landing there once it dries lights
  // one cell and grows no front; and the weld (`owner[j] !== f.id`), so any *other*
  // front treats the cell as a wall. Found in review, confirmed here; not fixed yet.

  it('setup: the front claims wet island cells without lighting them; the raster burns the dried island from an ember', () => {
    const h = wetIslandEmber('huygens');
    expect(h.claimedUnlit).toBeGreaterThan(0); // non-vacuous: a claimed, unlit cell exists
    expect(h.emberCellClaimed).toBe(true); // …and the ember lands on one
    expect(wetIslandEmber('raster').stillUnburned).toBe(0); // the reference engine burns it all
  }, 30_000);

  it.fails('an ember on a claimed-but-unlit cell burns the dried island, as on the raster', () => {
    // Measured before any fix: 79 of the island's 80 cells stay unburned — the
    // ember cell lights, no front is seeded from it, and the island never burns.
    // Remove `.fails` once the claim is moved behind the `carriesFire` gate.
    expect(wetIslandEmber('huygens').stillUnburned).toBe(0);
  }, 30_000);
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

  it('holds byte-for-byte with SPOTTING ON — the many-front path (item 5)', () => {
    // The test above runs `spotting: false`, so it only ever has one front and
    // never exercises the code Stage 2 added: first-owner-wins, welding and
    // retirement all depend on the order fronts are created and processed. With
    // spotting on, `timber-crown-run` carries hundreds of concurrent fronts, so
    // this is the determinism gate on the new machinery.
    const base = findPreset('timber-crown-run')!;
    const once = (): number => {
      const l = loadScenario({
        ...base,
        width: 64,
        height: 64,
        spreadEngine: 'huygens',
        ignitions: 'center',
        agents: undefined,
      });
      l.sim.run(700, 1); // well past the first embers, into the multi-front regime
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
    expect(a).not.toBe(0x811c9dc5);
  }, 30_000);
});
