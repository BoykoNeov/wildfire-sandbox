import { describe, it, expect } from 'vitest';
import {
  surfaceSpread,
  liveMoistureOfExtinction,
  type FuelBed,
} from '../src/sim/rothermel';
import { ANDERSON_13, fuelBed, deadFuelBed, hasLiveFuel } from '../src/sim/anderson13';
import { createWorld, FireState, type WorldState } from '../src/core/world';
import { Simulation } from '../src/core/simulation';
import { RothermelFireModel } from '../src/sim/rothermelFireModel';
import { Anderson13FuelModel } from '../src/sim/anderson13';
import { ftPerMinToMetersPerSec } from '../src/sim/rothermel';
import { byteToFraction } from '../src/core/moisture';

/**
 * Acceptance tests for the dead/live two-category Rothermel 1972 form (Albini 1976
 * refinements). The pure `surfaceSpread` assembly is cross-checked two ways that a
 * transcription bug can't both survive:
 *
 *  1. Against an INDEPENDENT verbatim port of the firelab/behave assembly
 *     (`surfaceFuelbedIntermediates.cpp` + `surfaceFireReactionIntensity.cpp`,
 *     commit d963287f60a6) — the R0 / M_x,live literals below were produced by
 *     that separate port at zero wind + zero slope, the only regime where the
 *     BehavePlus machinery collapses to a directly comparable R0 (no 20-ft→
 *     midflame adjustment, no wind/slope vector geometry, no direction-of-max
 *     search). Two independent ports agreeing catches copy errors; a shared
 *     restatement would not. Labelled "reference algorithm", not an independent
 *     field dataset.
 *  2. The live moisture of extinction is ALSO checked against a hand-worked
 *     arithmetic example (`liveMoistureOfExtinction` block) — genuinely
 *     independent of any port.
 *
 * Plus the reduction guarantee: a dead-only bed is bit-identical to the
 * single-category path (so `spread-ros`/`rothermel` stay green), and the
 * documented FM6/FM9 shift to size-class-weighted net load is pinned.
 */

const CALM = { midflameWind: 0, tanSlope: 0 };
const DEAD = 0.08; // 8% dead-fuel moisture
const LIVE = 1.0; //  100% live-fuel moisture

/** No-wind/no-slope R0 [ft/min] for a standard model at the test moistures. */
function r0(fm: number, live = LIVE): number {
  return surfaceSpread(fuelBed(ANDERSON_13.get(fm)!, DEAD, live), CALM).rateOfSpreadNoWindSlope;
}

describe('two-category surfaceSpread vs firelab/behave reference algorithm', () => {
  // dead = 8%, live = 100%, no wind, no slope. See file header for provenance.
  const R0_REF: ReadonlyArray<[number, number]> = [
    [1, 3.977038], // dead-only single class → identical to single-category form
    [2, 2.282656], // live herb 0.023 present
    [4, 4.287391], // chaparral — 46% live woody, the model this split unlocks
    [5, 0.738456], // brush — 57% live, previously ~halved by dead-only
    [6, 1.660433], // dead-only, but MULTI-class → size-class-weighted net load
    [9, 0.798116], // dead-only, multi-class
    [10, 0.804306], // timber litter + live woody
    [13, 1.785236], // heavy slash, dead-only multi-class
  ];

  it.each(R0_REF)('FM%i R0 matches the reference to 5 figures', (fm, expected) => {
    expect(r0(fm)).toBeCloseTo(expected, 5);
  });

  const MXLIVE_REF: ReadonlyArray<[number, number]> = [
    [4, 2.597948],
    [5, 1.078394],
    [10, 4.472085],
  ];
  it.each(MXLIVE_REF)('FM%i live moisture of extinction matches the reference', (fm, expected) => {
    const bed = fuelBed(ANDERSON_13.get(fm)!, DEAD, LIVE);
    expect(liveMoistureOfExtinction(bed)).toBeCloseTo(expected, 5);
  });
});

describe('dead-only reduction (bit-identical to the single-category form)', () => {
  const DEAD_ONLY = [1, 3, 6, 8, 9, 11, 12, 13];

  it.each(DEAD_ONLY)('FM%i carries no live fuel, so fuelBed == deadFuelBed', (fm) => {
    const m = ANDERSON_13.get(fm)!;
    expect(hasLiveFuel(m)).toBe(false);
    const two = surfaceSpread(fuelBed(m, DEAD, LIVE), CALM);
    const dead = surfaceSpread(deadFuelBed(m, DEAD), CALM);
    expect(two.rateOfSpread).toBe(dead.rateOfSpread);
    expect(two.reactionIntensity).toBe(dead.reactionIntensity);
  });

  it('FM1 (single dead class) still matches the hand-assembled single-category R0', () => {
    // FM1 has one dead class, so f_i = g_i = 1 and the two-category assembly is
    // algebraically the single-category model. Anchors it to `rothermel.test.ts`.
    expect(r0(1)).toBeCloseTo(3.977038, 5);
  });

  it('changing live moisture never affects a dead-only model', () => {
    for (const fm of DEAD_ONLY) {
      expect(r0(fm, 0.3)).toBe(r0(fm, 2.5));
    }
  });
});

describe('liveMoistureOfExtinction (Albini 1976, hand-worked)', () => {
  // One dead 1-hr class + one live class. Worked by hand:
  //   fineDead = 0.1·e^(−138/2000) = 0.09333272
  //   fineLive = 0.1·e^(−500/1500) = 0.07165313
  //   W = fineDead/fineLive = 1.302561 ; M_f,dead = 0.05
  //   M_x,live = 2.9·1.302561·(1 − 0.05/0.25) − 0.226 = 2.795942
  const bed: FuelBed = {
    particles: [
      { load: 0.1, sav: 2000, moisture: 0.05, category: 'dead' },
      { load: 0.1, sav: 1500, moisture: 1.2, category: 'live' },
    ],
    depth: 1.0,
    moistureOfExtinction: 0.25,
    heatContent: 8000,
  };

  it('matches the hand-computed value', () => {
    expect(liveMoistureOfExtinction(bed)).toBeCloseTo(2.795942, 5);
  });

  it('is independent of the live-fuel moisture itself (depends on dead fuel)', () => {
    const wetter: FuelBed = {
      ...bed,
      particles: [bed.particles[0], { ...bed.particles[1], moisture: 3.0 }],
    };
    expect(liveMoistureOfExtinction(wetter)).toBeCloseTo(liveMoistureOfExtinction(bed), 12);
  });

  it('clamps to the dead moisture of extinction when the formula falls below it', () => {
    // Dead fuel nearly at its own M_x → the (1 − M_f,dead/M_x,dead) term collapses,
    // driving the raw formula negative; it must clamp up to M_x,dead.
    const nearExtinction: FuelBed = {
      ...bed,
      particles: [{ ...bed.particles[0], moisture: 0.24 }, bed.particles[1]],
    };
    expect(liveMoistureOfExtinction(nearExtinction)).toBe(0.25);
  });

  it('returns the dead M_x for a bed with no live fuel', () => {
    expect(liveMoistureOfExtinction(deadFuelBed(ANDERSON_13.get(1)!, 0.06))).toBe(0.12);
  });
});

describe('two-category physical behaviour', () => {
  it('drier live fuel spreads faster (live moisture damping)', () => {
    const dry = r0(4, 0.6);
    const green = r0(4, 2.0);
    expect(dry).toBeGreaterThan(green);
    expect(green).toBeGreaterThan(0);
  });

  it('a wet live category does not veto spread the dead category still carries', () => {
    // FM2 is mostly dead (timber grass); soak the live herb past extinction and it
    // must still spread on the dead fuel — the per-category η_M must not zero I_R.
    const soaked = r0(2, 5.0);
    expect(soaked).toBeGreaterThan(0);
  });

  it('live fuel is dual-natured for FM5: dry live adds spread, green live suppresses it', () => {
    // FM5 (brush) is ~57% live, so the dead-only approximation is *qualitatively*
    // wrong, not just scaled: live fuel is extra combustible when dry but a heat
    // sink when green (its Q_ig soaks up energy without much reaction). This is the
    // real lesson the dead-only bed erased — high live moisture is a spread brake.
    const m = ANDERSON_13.get(5)!;
    const deadOnly = surfaceSpread(deadFuelBed(m, DEAD), CALM).rateOfSpreadNoWindSlope;
    const dryLive = r0(5, 0.3); // well below M_x,live (1.08) → live burns as fuel
    const greenLive = r0(5, 1.0); // green live → net heat sink
    expect(dryLive).toBeGreaterThan(deadOnly);
    expect(greenLive).toBeLessThan(deadOnly);
  });
});

describe('RothermelFireModel liveMoisture wiring (integration through the front)', () => {
  // Everything else drives `surfaceSpread` directly; this is the only test that
  // proves the ctor `liveMoisture` param flows through `fuelBed` → the spread
  // accumulator → the measured front. FM4 (chaparral, 46% live woody) is the
  // model whose behaviour is live-driven, so the front actually responds.
  const FM = 4;
  const DEAD_BYTE = 20; // byteToFraction(20) ≈ 7.8% dead-fuel moisture

  function planarFM4Front(cellSize: number): WorldState {
    const w = createWorld({ width: 40, height: 5, seed: 1, cellSize });
    w.layers.fuel.data.fill(FM);
    w.layers.moisture.data.fill(DEAD_BYTE);
    for (let y = 0; y < w.height; y++) w.layers.fire.set(0, y, FireState.Burning);
    return w;
  }
  function frontColumn(w: WorldState): number {
    const my = w.height >> 1;
    let front = 0;
    for (let x = 0; x < w.width; x++) {
      const s = w.layers.fire.get(x, my);
      if (s === FireState.Burning || s === FireState.Burned) front = x;
    }
    return front;
  }
  function runFront(liveMoisture: number, cellSize: number): number {
    const world = planarFM4Front(cellSize);
    new Simulation(world, [
      new RothermelFireModel(new Anderson13FuelModel(), liveMoisture),
    ]).run(600, 1);
    return frontColumn(world);
  }

  it('a dry-live front outruns a green-live front (both carry, FM4 live Mx≈2.6)', () => {
    const dead = byteToFraction(DEAD_BYTE);
    const m = ANDERSON_13.get(FM)!;
    // Size the cell to the dry-live analytic R0 so the dry front crosses ~15 cells.
    const r0DryMps = ftPerMinToMetersPerSec(
      surfaceSpread(fuelBed(m, dead, 0.5), CALM).rateOfSpread,
    );
    const cellSize = 40 * r0DryMps;

    const dryFront = runFront(0.5, cellSize); // dry live fuel → extra combustible
    const greenFront = runFront(2.0, cellSize); // green (but < live Mx) → weak sink

    expect(dryFront).toBeGreaterThan(greenFront);
    expect(greenFront).toBeGreaterThan(0); // 2.0 < live Mx (2.6) so it still carries
  });
});

describe('documented net-load change for multi-class dead beds (FM6/FM9)', () => {
  it('uses the size-class-weighted net load, well below the raw summed load', () => {
    // The pre-split single-category code summed dead loads raw: FM6 net load
    // 0.2607 lb/ft². BehavePlus weights by SAV size class → 0.0696, so R0 drops to
    // ~0.27×. Pin the new (correct) value; see anderson13.ts header + plan D6.
    expect(r0(6)).toBeCloseTo(1.660433, 5); // was ~6.2 ft/min under raw-sum
    expect(r0(9)).toBeCloseTo(0.798116, 5);
  });
});
