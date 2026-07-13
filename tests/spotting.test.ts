import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import type { System } from '../src/core/system';
import { Anderson13FuelModel } from '../src/sim/anderson13';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { SpottingSystem } from '../src/sim/spottingSystem';

/**
 * Pins the Phase-3 spotting mechanic: a burning cell throws embers downwind that
 * ignite fuel *across a gap the surface fire physically cannot cross*.
 *
 * Geometry — a wide, short landscape of dry timber (canopy-bearing, so it
 * torches) split by a vertical NONBURNABLE firebreak. Surface spread can never
 * enter a nonburnable cell, so the far side is unreachable by the front at any
 * speed — an infinitely strong barrier, not merely "faster than the front". A
 * band of columns just upwind of the break is held burning as a sustained ember
 * source (a front parked at the break), and a strong steady EAST wind loft embers
 * across. The discriminator: with {@link SpottingSystem} the far side ignites;
 * without it the identical scenario leaves the far side stone cold.
 */

const W = 40;
const H = 13;
const FM_TIMBER = 10; // FM10 timber — burnable, canopy-worthy, dead Mx 0.25.
const DRY = 10; // ≈ 4% dead-fuel moisture — a receptive brand bed.
const CANOPY = 200; // timber canopy → embers actually loft.
const WIND_EAST = 12; // m/s, strong steady east wind.

const GAP_START = 20;
const GAP_END = 24; // nonburnable columns [20, 24): 4 cells = 120 m, an absolute barrier.
const SOURCE_COLS = [16, 17, 18, 19]; // the burning wall parked just upwind of the break.
const FAR_START = GAP_END; // downwind (east) burnable field — reachable only by embers.

/** Dry timber everywhere, a nonburnable vertical firebreak carved through it. */
function makeWorld(seed: number): WorldState {
  const world = createWorld({ width: W, height: H, seed, cellSize: 30 });
  world.layers.fuel.data.fill(FM_TIMBER);
  world.layers.moisture.data.fill(DRY);
  world.layers.canopy.data.fill(CANOPY);
  // Steady uniform east wind, written straight into the layer (no provider needed).
  world.layers.windU.data.fill(WIND_EAST);
  // Carve the firebreak: nonburnable, no canopy.
  for (let y = 0; y < H; y++) {
    for (let x = GAP_START; x < GAP_END; x++) {
      const i = y * W + x;
      world.layers.fuel.data[i] = 0;
      world.layers.canopy.data[i] = 0;
    }
  }
  return world;
}

/**
 * Step `world` for `steps` ticks, re-stamping the source columns to Burning (and
 * zeroing their burn clock) each tick so they never flame out — a front held at
 * the break, throwing embers for the whole run.
 */
function runSustained(world: WorldState, systems: System[], steps: number): void {
  const sim = new Simulation(world, systems);
  const burnElapsed = world.layers.burnElapsed.data;
  for (let s = 0; s < steps; s++) {
    for (const x of SOURCE_COLS) {
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        world.layers.fire.data[i] = FireState.Burning;
        burnElapsed[i] = 0;
      }
    }
    sim.step(1);
  }
}

/** Count ignited (Burning|Burned) cells in the downwind far field (x ≥ FAR_START). */
function farFieldIgnited(world: WorldState): number {
  const fire = world.layers.fire.data;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = FAR_START; x < W; x++) {
      if (fire[y * W + x] !== FireState.Unburned) n++;
    }
  }
  return n;
}

describe('spotting jumps a firebreak the surface fire cannot cross', () => {
  const SEEDS = [1, 2, 7, 42, 1337];

  it('WITH spotting: embers ignite fuel beyond the nonburnable gap (every seed)', () => {
    for (const seed of SEEDS) {
      const world = makeWorld(seed);
      const fuel = new Anderson13FuelModel();
      runSustained(world, [new RothermelFireModel(fuel), new SpottingSystem(fuel)], 120);
      expect(farFieldIgnited(world)).toBeGreaterThan(0);
    }
  });

  it('WITHOUT spotting: the surface fire never reaches the far side (every seed)', () => {
    // Same scenario, spotting removed. Surface spread cannot enter the nonburnable
    // break, so the downwind field must stay entirely cold — proving the far-side
    // ignitions above are embers, not the front leaking across.
    for (const seed of SEEDS) {
      const world = makeWorld(seed);
      const fuel = new Anderson13FuelModel();
      runSustained(world, [new RothermelFireModel(fuel)], 120);
      expect(farFieldIgnited(world)).toBe(0);
    }
  });
});

describe('spotting is downwind-directional', () => {
  it('embers land in the downwind (east) field, not the upwind (west) one', () => {
    // Nonburnable breaks on BOTH sides of the burning wall, burnable fields beyond
    // each. Wind blows east, so only the east field should catch embers; the west
    // field is upwind and must stay cold.
    const seed = 7;
    const world = createWorld({ width: W, height: H, seed, cellSize: 30 });
    world.layers.fuel.data.fill(FM_TIMBER);
    world.layers.moisture.data.fill(DRY);
    world.layers.canopy.data.fill(CANOPY);
    world.layers.windU.data.fill(WIND_EAST);

    // West break at columns [8,12); east break at [20,24). Source wall 16..19 sits
    // between the east break and the middle; west field is columns < 8.
    const westGap: [number, number] = [8, 12];
    const eastGap: [number, number] = [20, 24];
    for (let y = 0; y < H; y++) {
      for (const [a, b] of [westGap, eastGap]) {
        for (let x = a; x < b; x++) {
          const i = y * W + x;
          world.layers.fuel.data[i] = 0;
          world.layers.canopy.data[i] = 0;
        }
      }
    }

    const fuel = new Anderson13FuelModel();
    runSustained(world, [new RothermelFireModel(fuel), new SpottingSystem(fuel)], 120);

    const fire = world.layers.fire.data;
    let east = 0;
    let west = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 24; x < W; x++) if (fire[y * W + x] !== FireState.Unburned) east++;
      for (let x = 0; x < 8; x++) if (fire[y * W + x] !== FireState.Unburned) west++;
    }
    expect(east).toBeGreaterThan(0); // downwind field caught embers
    expect(west).toBe(0); // upwind field stayed cold
  });
});

describe('spotting is deterministic', () => {
  it('same seed → byte-for-byte identical fire (and spotting actually fired)', () => {
    const run = (): WorldState => {
      const world = makeWorld(2024);
      const fuel = new Anderson13FuelModel();
      runSustained(world, [new RothermelFireModel(fuel), new SpottingSystem(fuel)], 90);
      return world;
    };
    const a = run();
    const b = run();
    expect(Array.from(a.layers.fire.data)).toEqual(Array.from(b.layers.fire.data));
    // Guard against a vacuous pass: the run must have actually spotted across.
    expect(farFieldIgnited(a)).toBeGreaterThan(0);
  });
});
