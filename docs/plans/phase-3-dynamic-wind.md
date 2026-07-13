# Phase 3 — Dynamic wind (time-varying + spatially-varying)

> **Status: LANDED (second Phase-3 step).** Wind is no longer a single constant
> vector. A provider now writes a **time-varying mean** (keyframe-interpolated) with
> an optional **drifting gust field** into `windU/windV` each tick, and the long-open
> **wind-sampling convention** is settled. Spotting has since also landed —
> [`phase-3-spotting.md`](./phase-3-spotting.md) — so Phase 3 is complete.

**Goal (roadmap §6 "P3 dynamic wind/rain/spotting"; handoff §4.3):** make wind the
headline dynamic event — *"a shift flips which flank is dangerous"* — and make it
spatially varied, which forces the wind-sampling convention to be settled.

## What shipped

- **`src/sim/dynamicWeather.ts` — `DynamicWeatherProvider`** (an `IWeatherProvider`,
  the same seam as `UniformWeatherProvider`; nothing downstream changed).
  - **Temporal (headline):** a list of `WindKeyframe { time, u, v }` for the *mean*
    wind, **linearly interpolated** in time and held flat before the first / after
    the last. Authoring a shift is two keyframes; the front reorganizes around it.
  - **Spatial (texture):** an optional drifting **coherent value-noise gust field** —
    per cell, speed varies multiplicatively and direction additively around the mean.
    A periodic (wrapping) 8×8 lattice sampled at a time-shifted coordinate, so gusts
    travel. This is what makes the convention (below) *load-bearing*.
  - **Determinism:** the gust lattice is seeded once from its **own `Rng`**, never
    `world.rng`. Drawing from the shared stream per tick would perturb every
    RNG-consuming model (the CA) and break reproducibility. Pure arithmetic per tick,
    no `Math.random`.
- **`main.ts` + `tools/renderFrame.ts`** now wire the dynamic provider: wind swings
  NE → N → NW over 30 sim-minutes with gusts. (Uniform provider retained — it still
  backs the moisture tests and the determinism golden.)

## The wind-sampling convention (settled)

The two fire models read wind from a cell each tick; under uniform wind it never
mattered *which* cell. It does once wind varies spatially. **Settled: both models
sample wind at the DESTINATION cell** — the cell the front is spreading *into*.

- **Principle:** a cell's own spread inputs are read at that cell. `ROS`-into-`i` is
  computed from `i`'s fuel bed, `i`'s moisture, and `i`'s wind; only slope/direction
  is inherently relational (`neighbour → i`). Wind is a field like moisture — pair it
  with the bed it drives. Under the arrival-time model actually in use (Rothermel ROS
  = front speed *through the fuel bed at `i`*), destination is the internally
  consistent choice.
- **Change:** `RothermelFireModel` already sampled `wind[i]` (destination). `CaFireModel`
  sampled `wind[ni]` (the source neighbour) while reading `moist[i]` (destination) —
  self-inconsistent. Fixed to `wind[i]` and hoisted out of the neighbour loop
  (constant across neighbours now). **No-op under uniform wind**, so the CA
  determinism golden holds byte-for-byte — no regen.
- **Pinned:** `tests/wind-convention.test.ts` writes a *spatial step* wind field and
  asserts the asymmetry that only destination-sampling produces (Rothermel, exact;
  plus an RNG-free CA diagnostic). The convention is documented on `world.ts`
  `windU/windV`.

## Verified

- **`tests/wind-convention.test.ts`** (3) — destination-sampling pinned for both models.
- **`tests/dynamic-weather.test.ts`** (4) — a wind reversal flips the dangerous flank
  end-to-end (east flank leads under early east wind; west flank overtakes after the
  shift); determinism (same config → byte-identical fire); gusts are spatially
  non-uniform; mean-only is spatially uniform.
- Full suite 115/115, typecheck clean, `npm run frame` renders the shifting-wind burn.
- **Not visible in a short browser session on its own** — the renderer draws no wind
  overlay (Phase-5 polish), so wind shows only through its effect on the front.
  Verify headless.

## Documented deferrals

- **Terrain-driven wind** (channelling through valleys, acceleration over ridges) —
  deliberately **not** modeled; that is CFD-adjacent and against handoff §2.1. A
  future provider can add it behind this same seam without touching a reader.
- **A wind overlay in the renderer** (arrows / streamlines) — Phase-5 polish, not
  needed to discharge this step.
- **Time-varying ambient drivers** (temp/humidity/rain keyframes) — the provider keeps
  those constant for now; the moisture step already exercises env-driven dynamics.

## The remaining Phase-3 piece

- **Spotting** — **LANDED.** Embers launched ahead of the front start new
  ignitions, including across firebreaks the surface fire can't cross. See
  [`phase-3-spotting.md`](./phase-3-spotting.md). Phase 3 is now complete.
