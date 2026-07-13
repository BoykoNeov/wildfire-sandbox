import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { TerrainFuelModel } from '../src/sim/terrainFuelModel';
import { Engine } from '../src/sim/engine';
import { Fuel } from '../src/sim/basicFuelModel';
import { fractionToByte } from '../src/core/moisture';

/**
 * Unit + acceptance tests for the {@link Engine} suppression agent (Phase-4 4b).
 * The headline is the **reload cycle** — the slice's exit criterion: an engine
 * holds an edge, runs dry, reloads, resumes. All flat, uniform grass so travel and
 * the tank arithmetic are exactly computable — the engine is pure deterministic
 * arithmetic (no `world.rng`).
 */

const W = 30;
const H = 9;
const MID = H >> 1;

/** Flat, uniform grass field (elevation 0), moisture bone dry. */
function grassField(): WorldState {
  const world = createWorld({ width: W, height: H, seed: 1, cellSize: 30 });
  world.layers.fuel.data.fill(Fuel.Grass);
  return world;
}

describe('Engine direct attack (finite water)', () => {
  it('wets the unburned footprint and draws the tank down while on station', () => {
    const world = grassField();
    const station = 10;
    const engine = new Engine({
      x: station,
      y: MID,
      capacityLiters: 100,
      drawRateLps: 10,
    });
    engine.orderDirectAttack(station, MID);
    const sim = new Simulation(world, [engine]);

    sim.step(1); // on station from the start → flows this tick
    // The 5×5 footprint (radius 2) is wetted to the knockdown target…
    const wet = fractionToByte(0.9);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        expect(world.layers.moisture.data[(MID + dy) * W + (station + dx)]).toBe(wet);
      }
    }
    // …and one tick of flow has drawn the tank down by drawRate·dt.
    expect(engine.waterLiters).toBe(90);
  });

  it('does not draw water while travelling to a distant station', () => {
    const world = grassField();
    const engine = new Engine({
      x: 0,
      y: MID,
      speed: 0.1,
      capacityLiters: 100,
      drawRateLps: 10,
    });
    engine.orderDirectAttack(20, MID); // 20 cells away — many ticks of driving
    const sim = new Simulation(world, [engine]);

    for (let t = 0; t < 30; t++) sim.step(1);
    expect(engine.cellX).toBeLessThan(20); // still en route
    expect(engine.waterLiters).toBe(100); // full — water only flows on station
  });

  it('a new direct-attack order replaces the prior station (holds one edge)', () => {
    const engine = new Engine({ x: 5, y: MID });
    engine.orderDirectAttack(5, MID);
    engine.orderDirectAttack(8, 2);
    expect(engine.targetCell).toEqual({ x: 8, y: 2 });
  });
});

describe('Engine reload cycle (4b exit criterion: holds → runs dry → reloads → resumes)', () => {
  it('runs the tank dry on station, drives to water, refills, and resumes the same station', () => {
    const world = grassField();
    const station = 10;
    const refill = 2; // 8 cells west of the station
    const capacity = 100;
    const engine = new Engine({
      x: station,
      y: MID,
      speed: 0.5,
      capacityLiters: capacity,
      drawRateLps: 10, // 10 s of water from a full tank
      refillSeconds: 10,
      refillX: refill,
      refillY: MID,
    });
    engine.orderDirectAttack(station, MID);
    const sim = new Simulation(world, [engine]);

    let ranDry = false; // tank hit 0 while holding the station
    let leftForWater = false; // reached the refill point (broke off the station)
    let reloaded = false; // tank back to full after having run dry
    let resumed = false; // back on station and flowing water again

    for (let t = 0; t < 250; t++) {
      sim.step(1);
      const atStation = engine.cellX === station && engine.cellY === MID;
      const atRefill = engine.cellX === refill && engine.cellY === MID;

      // (a) holds the edge until the tank empties, still on station.
      if (!leftForWater && atStation && engine.waterLiters === 0) ranDry = true;
      // (b) breaks off and reaches the water source.
      if (ranDry && atRefill && engine.isRefilling) leftForWater = true;
      // (c) tops the tank back up.
      if (leftForWater && engine.waterLiters === capacity) reloaded = true;
      // (d) returns to the SAME station and flows water again — the discriminator
      //     that proves it resumed the held order rather than never leaving.
      if (reloaded && atStation && engine.waterLiters < capacity) resumed = true;
    }

    expect(ranDry).toBe(true);
    expect(leftForWater).toBe(true);
    expect(reloaded).toBe(true);
    expect(resumed).toBe(true);
  });
});

describe('Engine doctrine: with water it HOLDS an edge, but its footprint is flanked', () => {
  // Parity with the crew's doctrine test (`suppression.test.ts`), run against a live
  // Rothermel front: an engine on a single station, given ample water so it never
  // breaks off to refill, insulates its 5×5 footprint — yet a point engine cannot
  // cover a wide front, so the fire rounds the wet patch. Encodes the 4b teaching
  // beat: even with water an engine only *holds*; the durable stop is the crew's line.
  const FW = 48;
  const FH = 13;
  const FMID = FH >> 1;
  const STATION = 24;

  /** Dry grass, steady east wind, the west column ignited as a planar front. */
  function grassFront(): WorldState {
    const world = createWorld({ width: FW, height: FH, seed: 1, cellSize: 30 });
    world.layers.fuel.data.fill(Fuel.Grass);
    world.layers.moisture.data.fill(10); // ≈4% dead moisture, below FM1 Mx 0.12
    world.layers.windU.data.fill(6); // m/s east, steady
    for (let y = 0; y < FH; y++) world.layers.fire.data[y * FW] = FireState.Burning;
    return world;
  }

  it('the station stays unburned while the tank has water; the front escapes past it', () => {
    const world = grassFront();
    const engine = new Engine({
      x: STATION,
      y: FMID,
      capacityLiters: 1e6, // ample — never breaks off to refill during this run
    });
    engine.orderDirectAttack(STATION, FMID);
    // Suppression before fire (weather → moisture → suppression → fire), so the wet
    // patch lands before the fire model reads it this tick.
    const sim = new Simulation(world, [engine, new RothermelFireModel(new TerrainFuelModel())]);
    for (let t = 0; t < 400; t++) sim.step(1);

    expect(engine.waterLiters).toBeGreaterThan(0); // held the whole run on water
    // The fully-wetted footprint centre never ignites — the front is denied there…
    expect(world.layers.fire.data[FMID * FW + STATION]).toBe(FireState.Unburned);
    // …yet the point engine cannot cover the front's width, so it flanks past.
    let flanked = 0;
    for (let y = 0; y < FH; y++) {
      for (let x = STATION + 3; x < FW; x++) {
        if (world.layers.fire.data[y * FW + x] !== FireState.Unburned) flanked++;
      }
    }
    expect(flanked).toBeGreaterThan(0);
  });
});
