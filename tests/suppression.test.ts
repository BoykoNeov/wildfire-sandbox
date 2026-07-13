import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import type { System } from '../src/core/system';
import { TerrainFuelModel } from '../src/sim/terrainFuelModel';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { FuelMoistureSystem } from '../src/sim/fuelMoistureSystem';
import { GroundCrew } from '../src/sim/groundCrew';
import { Fuel } from '../src/sim/basicFuelModel';
import { fractionToByte } from '../src/core/moisture';

/**
 * Phase-4 4a acceptance tests (`docs/plans/phase-4-firefighting.md` §Verification),
 * mirroring the spotting suite. Suppression is layer-only, so these run the real
 * Rothermel front against layer writes — no fire-model surgery.
 *
 * Scenario substrate: a wide dry-grass field (FM1 via {@link TerrainFuelModel}) with
 * a steady EAST wind and the whole west edge ignited, so a planar front marches east
 * at ~0.14 cell/tick. `CutLine` (id 4) resolves nonburnable through TerrainFuelModel;
 * spotting is deliberately absent (a cut line does NOT stop embers — that is correct
 * and out of scope for the barrier tests).
 */

const W = 48;
const H = 13;
const MID = H >> 1;
const DRY = 10; // ≈ 4% dead-fuel moisture, below FM1 Mx 0.12 — the front carries.
const WIND_EAST = 6; // m/s, steady.

/** Dry grass, steady east wind, the west column (x=0) ignited as a planar source. */
function grassFront(): WorldState {
  const world = createWorld({ width: W, height: H, seed: 1, cellSize: 30 });
  world.layers.fuel.data.fill(Fuel.Grass);
  world.layers.moisture.data.fill(DRY);
  world.layers.windU.data.fill(WIND_EAST);
  for (let y = 0; y < H; y++) world.layers.fire.data[y * W + 0] = FireState.Burning;
  return world;
}

/** Count ignited (Burning|Burned) cells in the far field x ≥ `x0`. */
function farIgnited(world: WorldState, x0: number): number {
  const fire = world.layers.fire.data;
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = x0; x < W; x++) if (fire[y * W + x] !== FireState.Unburned) n++;
  return n;
}

function run(world: WorldState, systems: System[], steps: number): void {
  const sim = new Simulation(world, systems);
  for (let s = 0; s < steps; s++) sim.step(1);
}

const LINE_X = 24; // where a control line / wet band sits across the front's path.
const FAR = LINE_X + 3; // strictly downwind of any 2-cell barrier at LINE_X.

describe('containment line stops the front (4a acceptance gate)', () => {
  it('a full-height CutLine band holds; the far side stays cold', () => {
    const world = grassFront();
    // A completed line: two full-height nonburnable columns across the whole path.
    for (let y = 0; y < H; y++) {
      world.layers.fuel.data[y * W + LINE_X] = Fuel.CutLine;
      world.layers.fuel.data[y * W + LINE_X + 1] = Fuel.CutLine;
    }
    run(world, [new RothermelFireModel(new TerrainFuelModel())], 400);

    // The front actually reached the line (non-vacuous)…
    expect(farIgnited(world, LINE_X - 1)).toBeGreaterThan(0);
    // …and could not cross it.
    expect(farIgnited(world, FAR)).toBe(0);
  });
});

describe('a wet band stalls the front, then the front crosses as it dries', () => {
  it('moisture above extinction holds while wet; drydown lets the front cross', () => {
    const world = grassFront();
    // Dry, warm air → EMC ≈ 3% (well below FM1 Mx 0.12), so the band dries out.
    world.env.temperatureC = 32;
    world.env.relativeHumidity = 15;
    world.env.rainRate = 0;
    // A band just above extinction (0.14 > 0.12): blocks now, crosses ~tick 750+.
    const wet = fractionToByte(0.14);
    for (let y = 0; y < H; y++) {
      world.layers.moisture.data[y * W + LINE_X] = wet;
      world.layers.moisture.data[y * W + LINE_X + 1] = wet;
    }
    const systems = [new FuelMoistureSystem(), new RothermelFireModel(new TerrainFuelModel())];

    // Phase 1 — while wet, the front reaches the band but cannot cross.
    run(world, systems, 300);
    expect(farIgnited(world, LINE_X - 1)).toBeGreaterThan(0); // front arrived at the band
    expect(farIgnited(world, FAR)).toBe(0); // wet band held

    // Phase 2 — keep drying; once EMC pulls the band below extinction the front crosses.
    run(world, systems, 1300);
    expect(farIgnited(world, FAR)).toBeGreaterThan(0); // water was temporary
  });
});

describe('logistics: travel time gates line work', () => {
  it('a crew ordered to a distant cell cannot line it before its travel time', () => {
    const world = createWorld({ width: W, height: H, seed: 1, cellSize: 30 });
    world.layers.fuel.data.fill(Fuel.Grass); // flat, no fire — pure logistics
    const crew = new GroundCrew(new TerrainFuelModel(), { x: 0, y: MID, speed: 0.1 });
    const target = 20;
    crew.orderCutLine(target, MID);
    const sim = new Simulation(world, [crew]);
    const i = MID * W + target;

    // Travel alone is 20 / 0.1 = 200 s; at t = 150 the crew hasn't even arrived.
    for (let t = 0; t < 150; t++) sim.step(1);
    expect(world.layers.fuel.data[i]).toBe(Fuel.Grass); // not lined yet

    // After arrival + line time the cell is cut.
    for (let t = 150; t < 230; t++) sim.step(1);
    expect(world.layers.fuel.data[i]).toBe(Fuel.CutLine);
  });
});

describe('doctrine: direct attack alone does not contain; a cut line does', () => {
  // Identical fronts. One crew knocks down (wets) the edge at a single station each
  // tick; the other scenario has a full-height line cut ahead. Only the line holds —
  // the point crew's wet patch is flanked. Encodes handoff §4.4 as a test.
  const STATION = 24;

  it('direct attack: the front flanks the wet patch and escapes downwind', () => {
    const world = grassFront();
    const crew = new GroundCrew(new TerrainFuelModel(), { x: STATION, y: MID });
    crew.orderDirectAttack(STATION, MID); // sticky: re-wets its footprint every tick
    run(world, [crew, new RothermelFireModel(new TerrainFuelModel())], 400);

    // The knockdown is real AND lands on the right cells: the crew's fully-wetted
    // 3×3 footprint insulates the station, so it never ignites — the discriminator
    // that reads the escape below as *flanking*, not a no-op. (A spike on the
    // burning cell instead of unburned fuel would let the station ignite here.)
    expect(world.layers.fire.data[MID * W + STATION]).toBe(FireState.Unburned);
    expect(world.layers.moisture.data[MID * W + STATION]).toBeGreaterThanOrEqual(fractionToByte(0.6) - 1);
    // …yet a point crew cannot cover the front's width, so the fire gets past.
    expect(farIgnited(world, STATION + 2)).toBeGreaterThan(0);
  });

  it('cut line: a full-height line ahead of the same front contains it', () => {
    const world = grassFront();
    for (let y = 0; y < H; y++) {
      world.layers.fuel.data[y * W + STATION] = Fuel.CutLine;
      world.layers.fuel.data[y * W + STATION + 1] = Fuel.CutLine;
    }
    run(world, [new RothermelFireModel(new TerrainFuelModel())], 400);
    expect(farIgnited(world, STATION + 3)).toBe(0); // contained
  });
});

describe('anchor point: an unanchored line is flanked at its open end', () => {
  // A line is only as good as its anchors. Both scenarios cut the SAME two columns
  // across the front's path; the only difference is whether the line reaches the
  // bottom map edge. Because CutLine is nonburnable the front can never leak
  // *through* it, so any far-side ignition proves it rounded the open end.
  const lineRows = (world: WorldState, fromY: number, toY: number): void => {
    for (let y = fromY; y < toY; y++) {
      world.layers.fuel.data[y * W + LINE_X] = Fuel.CutLine;
      world.layers.fuel.data[y * W + LINE_X + 1] = Fuel.CutLine;
    }
  };

  it('a line short of the map edge is flanked; a fully anchored line is not', () => {
    // Fully anchored: line spans edge to edge → the front is contained.
    const anchored = grassFront();
    lineRows(anchored, 0, H);
    run(anchored, [new RothermelFireModel(new TerrainFuelModel())], 500);
    expect(farIgnited(anchored, FAR)).toBe(0);

    // Unanchored: identical line but the bottom two rows are open → the front
    // rounds the open end and reaches the far side.
    const open = grassFront();
    lineRows(open, 0, H - 2);
    run(open, [new RothermelFireModel(new TerrainFuelModel())], 500);
    expect(farIgnited(open, FAR)).toBeGreaterThan(0);
  });
});
