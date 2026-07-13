import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { TerrainFuelModel } from '../src/sim/terrainFuelModel';
import { GroundCrew } from '../src/sim/groundCrew';
import { Fuel } from '../src/sim/basicFuelModel';

/**
 * Unit tests for the {@link GroundCrew} suppression agent (Phase-4 4a): travel
 * timing, the cut-line-on-Unburned guard, and backburn ignition. All flat, uniform,
 * fire-free where possible so expected tick counts are computable — the crew is pure
 * deterministic arithmetic (no `world.rng`).
 */

const W = 20;
const H = 13;
const MID = H >> 1;

/** Flat, uniform grass field (elevation 0) so travel speed is exactly the base speed. */
function grassField(): WorldState {
  const world = createWorld({ width: W, height: H, seed: 1, cellSize: 30 });
  world.layers.fuel.data.fill(Fuel.Grass);
  return world;
}

describe('GroundCrew travel', () => {
  it('reaches a distant target in ~distance/speed ticks (flat grass)', () => {
    const world = grassField();
    const crew = new GroundCrew(new TerrainFuelModel(), { x: 0, y: MID, speed: 0.1 });
    crew.orderCutLine(10, MID); // 10 cells away; at 0.1 cell/s → ~100 ticks to arrive
    const sim = new Simulation(world, [crew]);

    for (let t = 0; t < 40; t++) sim.step(1);
    expect(crew.cellX).toBeLessThan(10); // still en route well before travel time

    for (let t = 40; t < 110; t++) sim.step(1);
    expect(crew.cellX).toBe(10); // arrived
    expect(crew.cellY).toBe(MID);
  });

  it('heavy fuel slows travel below the flat-grass baseline', () => {
    const grass = grassField();
    const timber = grassField();
    timber.layers.fuel.data.fill(Fuel.Timber); // higher travel resistance

    const runFor = (world: WorldState): number => {
      const crew = new GroundCrew(new TerrainFuelModel(), { x: 0, y: MID, speed: 0.1 });
      crew.orderCutLine(W - 1, MID);
      const sim = new Simulation(world, [crew]);
      for (let t = 0; t < 60; t++) sim.step(1);
      return crew.cellX;
    };
    expect(runFor(grass)).toBeGreaterThan(runFor(timber)); // grass crew is further along
  });
});

describe('GroundCrew cut-line', () => {
  it('cuts line on an Unburned cell (fuel → CutLine)', () => {
    const world = grassField();
    const crew = new GroundCrew(new TerrainFuelModel(), { x: 5, y: MID }); // starts on target
    crew.orderCutLine(5, MID);
    const sim = new Simulation(world, [crew]);

    const i = MID * W + 5;
    expect(world.layers.fuel.data[i]).toBe(Fuel.Grass); // not yet cut
    for (let t = 0; t < 12; t++) sim.step(1); // base line time is 8 s
    expect(world.layers.fuel.data[i]).toBe(Fuel.CutLine);
    expect(crew.isIdle).toBe(true); // order completed and popped
  });

  it('refuses to cut a Burning cell (never plants a CutLine under fire)', () => {
    const world = grassField();
    const i = MID * W + 5;
    world.layers.fire.data[i] = FireState.Burning; // the front already reached it
    const crew = new GroundCrew(new TerrainFuelModel(), { x: 5, y: MID });
    crew.orderCutLine(5, MID);
    const sim = new Simulation(world, [crew]);

    for (let t = 0; t < 20; t++) sim.step(1);
    expect(world.layers.fuel.data[i]).toBe(Fuel.Grass); // stayed burnable; not turned to CutLine
    expect(crew.isIdle).toBe(true); // impossible order was dropped
  });
});

describe('GroundCrew backburn', () => {
  it('ignites an unburned burnable cell', () => {
    const world = grassField();
    const i = MID * W + 5;
    const crew = new GroundCrew(new TerrainFuelModel(), { x: 5, y: MID });
    crew.orderBackburn(5, MID);
    new Simulation(world, [crew]).step(1); // on-station → works this tick
    expect(world.layers.fire.data[i]).toBe(FireState.Burning);
  });

  it('does not ignite a nonburnable cell (no stray Burned source)', () => {
    const world = grassField();
    const i = MID * W + 5;
    world.layers.fuel.data[i] = Fuel.Nonburnable;
    const crew = new GroundCrew(new TerrainFuelModel(), { x: 5, y: MID });
    crew.orderBackburn(5, MID);
    new Simulation(world, [crew]).step(1);
    expect(world.layers.fire.data[i]).toBe(FireState.Unburned);
  });
});
