import { describe, it, expect } from 'vitest';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { TerrainFuelModel } from '../src/sim/terrainFuelModel';
import { Aircraft, crownFalloffEffectiveness } from '../src/sim/aircraft';
import { RetardantSystem } from '../src/sim/retardantSystem';
import { FuelMoistureSystem } from '../src/sim/fuelMoistureSystem';
import { Fuel } from '../src/sim/basicFuelModel';
import { fractionToByte } from '../src/core/moisture';

/**
 * Unit + acceptance tests for the Phase-4 4c aerial slice: the {@link Aircraft}
 * suppression agent, the {@link RetardantSystem} persistence substrate, and the two
 * exit criteria — **retardant persists past a water drop's drydown**, and **a drop on
 * a high-intensity crown fire is near-useless**. Everything is pure deterministic
 * arithmetic (no `world.rng`), so the geometry is exactly reproducible.
 */

// Timber's Anderson model (FM9) moisture of extinction — the falloff threshold the
// deposit math must straddle: a full drop (0.9) suppresses timber, a falloff-crippled
// one (≈0.13) does not. (Grass FM1 Mx is only 0.12, too low to show the lesson.)
const TIMBER_MX = 0.25;

describe('crown-fire falloff (pure) — the §4.4 teaching moment', () => {
  it('a drop on unburned fuel ahead of the front (no flaming neighbour) is full strength', () => {
    expect(crownFalloffEffectiveness(0)).toBe(1);
  });

  it('a drop on a flaming timber crown is near-useless — its deposit falls below extinction', () => {
    const timberCanopy = 200 / 255; // terrain gen paints timber canopy 200
    const eff = crownFalloffEffectiveness(timberCanopy);
    expect(eff).toBeLessThan(0.2);
    // The doctrine number: a full water knockdown is 0.9; scaled by this effectiveness
    // it lands BELOW timber's extinction moisture, so ROS is not zeroed — useless.
    expect(0.9 * eff).toBeLessThan(TIMBER_MX);
  });

  it('a drop on a flaming GRASS surface fire still works — low canopy barely dents it', () => {
    const grassCanopy = 10 / 255; // terrain gen paints grass canopy 10
    const eff = crownFalloffEffectiveness(grassCanopy);
    expect(eff).toBeGreaterThan(0.9); // a grass fire IS suppressible from the air
  });
});

// --- behavioural falloff: identical timber front, drop placement is the only lever --

const FW = 48;
const FH = 7; // one 7-tall drop (radius 3) spans the whole height → a full-width band
const FMID = FH >> 1;

/** Dry timber, steady east wind, a deep burning block on the west as a planar front.
 *  Canopy 200 everywhere = a timbered crown, so the falloff signal is live. */
function timberFront(): WorldState {
  const world = createWorld({ width: FW, height: FH, seed: 1, cellSize: 30 });
  world.layers.fuel.data.fill(Fuel.Timber);
  world.layers.canopy.data.fill(200);
  world.layers.moisture.data.fill(fractionToByte(0.15)); // dry, below FM9 Mx 0.25
  world.layers.windU.data.fill(8); // m/s east, steady
  // A deep burning block (x=0..8) so the front is well-established and an "on-run" drop
  // sits over active flame rather than ahead of a one-cell edge.
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x <= 8; x++) world.layers.fire.data[y * FW + x] = FireState.Burning;
  }
  return world;
}

/** Easternmost column index containing any ignited cell (front reach). */
function frontReach(world: WorldState): number {
  const { width, height, layers } = world;
  let max = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = layers.fire.data[y * width + x];
      if ((s === FireState.Burning || s === FireState.Burned) && x > max) max = x;
    }
  }
  return max;
}

/** Run a timber front for `ticks`, optionally dropping retardant centred at `dropX`
 *  on tick 1 (aircraft based ON the target so it drops immediately). Returns front reach. */
function runFront(ticks: number, dropX: number | null): number {
  const world = timberFront();
  const systems = [];
  if (dropX !== null) {
    const air = new Aircraft({ x: dropX, y: FMID });
    air.orderRetardantDrop(dropX, FMID);
    systems.push(air);
    systems.push(new RetardantSystem());
  }
  systems.push(new RothermelFireModel(new TerrainFuelModel()));
  const sim = new Simulation(world, systems);
  sim.run(ticks, 1);
  return frontReach(world);
}

describe('crown-fire falloff (behavioural, live Rothermel) — pre-treat ahead works, drop on the run does not', () => {
  it('a full-strength retardant band well AHEAD of the front stops it; a drop ON the flaming crown does not', () => {
    const TICKS = 4000;
    const control = runFront(TICKS, null); // no drop — how far the free front runs
    const ahead = runFront(TICKS, 28); // band far ahead (x=25..31), full strength
    const onRun = runFront(TICKS, 6); // drop over the flaming block (x=3..9)

    // Sanity: the free front runs well past the pre-treatment band's location.
    expect(control).toBeGreaterThan(31);
    // Ahead: the front is halted at the treated band — it never reaches its east edge.
    expect(ahead).toBeLessThan(25);
    // On the run: the falloff-crippled drop barely dents the front — it runs about as
    // far as with no drop at all (the near-useless crown-fire lesson).
    expect(onRun).toBeGreaterThan(control - 3);
    // And the contrast is unambiguous: pre-treatment ahead beats a drop on the run.
    expect(onRun - ahead).toBeGreaterThan(10);
  });
});

// --- reload cycle: fly out → drop once → return to base → reload → ready -------------

describe('Aircraft sortie + reload cycle', () => {
  const W = 40;
  const H = 7;
  const MID = H >> 1;

  function timberField(): WorldState {
    const world = createWorld({ width: W, height: H, seed: 1, cellSize: 30 });
    world.layers.fuel.data.fill(Fuel.Timber);
    return world;
  }

  it('flies to the target, lays ONE drop, returns to base, reloads, then is ready again', () => {
    const world = timberField();
    const base = 2;
    const target = 30;
    const air = new Aircraft({
      x: base,
      y: MID,
      speed: 0.5,
      reloadSeconds: 10,
      dropRadius: 1,
    });
    air.orderRetardantDrop(target, MID);
    const sim = new Simulation(world, [air, new RetardantSystem()]);

    let flewOut = false; // left base heading for the target
    let dropped = false; // laid retardant at the target, now unloaded + returning
    let backHome = false; // returned to base to reload
    let ready = false; // reloaded and idle, ready for the next sortie

    const targetI = MID * W + target;
    for (let t = 0; t < 300; t++) {
      sim.step(1);
      if (!dropped && air.cellX > base && air.isLoaded) flewOut = true;
      if (world.layers.retardant.data[targetI] > 0 && !air.isLoaded) dropped = true;
      if (dropped && air.cellX === base && air.isReturning) backHome = true;
      if (backHome && air.isLoaded && air.isIdle) ready = true;
    }

    expect(flewOut).toBe(true);
    expect(dropped).toBe(true);
    expect(backHome).toBe(true);
    expect(ready).toBe(true);
  });

  it('a second queued sortie only launches after the first has reloaded (one load at a time)', () => {
    const world = timberField();
    const air = new Aircraft({ x: 2, y: MID, speed: 0.5, reloadSeconds: 10, dropRadius: 1 });
    air.orderRetardantDrop(10, MID);
    air.orderRetardantDrop(20, MID);
    const sim = new Simulation(world, [air, new RetardantSystem()]);

    // Advance until the first drop has landed and the aircraft is returning to reload.
    let guard = 0;
    while (!air.isReturning && guard++ < 200) sim.step(1);
    expect(world.layers.retardant.data[MID * W + 10]).toBeGreaterThan(0); // first drop done
    expect(world.layers.retardant.data[MID * W + 20]).toBe(0); // second not yet flown

    for (let t = 0; t < 200; t++) sim.step(1); // let it reload and fly the second sortie
    expect(world.layers.retardant.data[MID * W + 20]).toBeGreaterThan(0);
  });

  it('the drop writes only suppression layers — it never un-burns or ignites a cell', () => {
    const world = timberField();
    for (let y = 0; y < H; y++) world.layers.fire.data[y * W + 5] = FireState.Burning;
    const before = Uint8Array.from(world.layers.fire.data);
    const air = new Aircraft({ x: 5, y: MID, dropRadius: 3 });
    air.orderWaterDrop(5, MID); // drop straddling the burning column
    const sim = new Simulation(world, [air]);
    sim.step(1);
    // The aircraft writes moisture only; the fire layer is byte-for-byte untouched.
    expect(Array.from(world.layers.fire.data)).toEqual(Array.from(before));
  });
});

// --- retardant persistence: the 4c exit criterion ----------------------------------

describe('retardant persists past a water drop’s drydown (4c exit)', () => {
  // A tiny dry field: one water-treated cell, one retardant-treated cell, no fire.
  // The shared FuelMoistureSystem dries the water cell toward EMC on the slow 1-hr
  // timelag; RetardantSystem holds the retardant cell up on its own (much longer)
  // schedule. Over a long-but-cheap window the water dries BELOW timber's extinction
  // while retardant stays ABOVE it — retardant outlasts water.
  const W = 8;
  const H = 3;
  const WATER_I = 1 * W + 2;
  const RET_I = 1 * W + 5;

  function dryField(pinDurationSec = 14400): { world: WorldState; sim: Simulation } {
    const world = createWorld({ width: W, height: H, seed: 1, cellSize: 30 });
    world.layers.fuel.data.fill(Fuel.Timber);
    world.layers.moisture.data.fill(fractionToByte(0.075)); // start near the dry EMC
    world.env.temperatureC = 25;
    world.env.relativeHumidity = 40; // EMC ≈ 7.5% — water dries toward this
    // A water drop = a one-shot moisture spike; a retardant drop = a retardant-layer write.
    world.layers.moisture.data[WATER_I] = fractionToByte(0.9);
    world.layers.retardant.data[RET_I] = 255;
    const sim = new Simulation(world, [
      new FuelMoistureSystem(),
      new RetardantSystem({ durationSeconds: pinDurationSec }),
    ]);
    return { world, sim };
  }

  it('after the same long window the water cell has dried below extinction; the retardant cell has not', () => {
    const { world, sim } = dryField();
    sim.run(6000, 1); // ~100 min: long enough for water to ride the 1-hr timelag down

    const mx = fractionToByte(TIMBER_MX);
    const water = world.layers.moisture.data[WATER_I];
    const ret = world.layers.moisture.data[RET_I];

    expect(water).toBeLessThan(mx); // water has dried out — a front could now cross it
    expect(ret).toBeGreaterThan(mx); // retardant still holds the bed above extinction
    expect(ret).toBeGreaterThan(water); // and is unambiguously wetter than the water cell
    expect(world.layers.retardant.data[RET_I]).toBeGreaterThan(0); // still potent
  });

  it('once the retardant expires, its cell is released and dries — no longer held up (the timer is real)', () => {
    const TICKS = 600;
    // Short-lived slurry: fully spent well within the window.
    const expiring = dryField(300);
    expiring.sim.run(TICKS, 1);
    // A control whose retardant never expires over the window (held the whole time).
    const held = dryField(14400);
    held.sim.run(TICKS, 1);

    expect(expiring.world.layers.retardant.data[RET_I]).toBe(0); // fully decayed
    // The moisture drydown is slow, so "released" shows not as a plunge but as the
    // expired cell falling BEHIND the still-pinned control: once the timer runs out the
    // re-pin stops and the cell starts drying, so it is measurably drier than one still held.
    const releasedM = expiring.world.layers.moisture.data[RET_I];
    const stillHeldM = held.world.layers.moisture.data[RET_I];
    expect(releasedM).toBeLessThan(stillHeldM);
  });
});
