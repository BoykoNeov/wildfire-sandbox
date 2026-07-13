# Phase 3 — Spotting (embers ahead of the front)

> **Status: LANDED (third and final Phase-3 step).** Burning cells now throw
> firebrands that ride the wind downwind and start new ignitions — including
> across firebreaks the surface fire physically cannot cross. This completes the
> Phase-3 "dynamic world" trio (moisture → wind → spotting).

**Goal (roadmap §6 "P3 dynamic wind/rain/spotting"; handoff §2.1, §6):** add the
piece that makes real fires unpredictable — a fire appearing far downwind of the
main front. Handoff §2.1 fixes the approach: *"plume rise / spotting = modeled
**phenomenologically** — launch embers as a function of intensity and wind, with
a lofting distribution. Model the **consequence** of the updraft, not the
updraft."* This is deliberately not firebrand-transport CFD.

## What shipped

- **`src/sim/spottingSystem.ts` — `SpottingSystem`** (a plain `System`, wired
  **after** the fire model). Each tick, over a fixed row-major sweep:
  - **Sources** are `Burning` cells with canopy > 0. **Canopy is the torching
    proxy** — grass (canopy ≈ 10) barely lofts brands; timber (≈ 200) throws far.
    Nonburnable/water (canopy 0) never spot.
  - **Launch** is a dt-robust Bernoulli `p = 1 − exp(−rate·dt)` with
    `rate = k · canopyFrac · windSpeed` — no wind ⇒ no spotting (and no undefined
    bearing at dead calm). One ember per cell per tick.
  - **Loft** is a heavy-tailed **exponential** downwind distance (mean scales with
    wind speed and canopy), so most brands drop near and a few carry far — the
    "lofting distribution". Bearing = wind direction ± a jitter cone.
  - **Reception**: the landing cell ignites only if in-bounds, unburned, burnable,
    and drier than its moisture of extinction, with probability rising as it dries.
- **`main.ts` + `tools/renderFrame.ts`** wire `SpottingSystem` after the fire
  model (`weather → moisture → fire → spotting`).

## Architecture fit (additive — nothing prior was rewritten)

- **A separate `System`, ordered after the fire model** (handoff §3.1 — systems
  talk only through layers, never call each other). It reads `fire` (sources),
  `canopy`, `windU/windV`, and `fuel`+`moisture` (landing reception); it writes
  new `Burning` cells back into `fire`. It takes an `IFuelModel` — a *seam*, not a
  system — for landing-cell reception, exactly as the fire model does.
- **Co-writer contract (load-bearing ordering).** Both the fire model and spotting
  write the `fire` layer. Spotting is the **additive** writer and **must run after**
  the fire model — surface spread first, ember ignitions layered on top.
  Reordering the pipeline would break this. Documented in the module header.
- **Snapshot / double-buffer discipline.** Ember ignitions are collected during
  the sweep and applied only *after* it. Writing them live would let a cell
  ignited by an ember this tick act as a new ember source in the *same* tick;
  because embers travel downwind and the sweep is row-major, a downwind wind would
  then cascade spot fires across the whole map in one tick while an upwind wind
  would not — a direction- and order-dependent bug. Deferring the writes gives
  clean snapshot semantics (and dedupes two embers landing on one cell).
- **Determinism preserved.** All randomness draws from `world.rng` in a fixed
  row-major order → a seed reproduces a run byte-for-byte (handoff §3.2). Spotting
  is the **only** stepping-time `world.rng` consumer in the Rothermel pipeline
  (the dynamic weather provider uses its own `Rng`; moisture and Rothermel draw
  none). The determinism golden uses the **CA** pipeline **without** spotting, so
  it is untouched — no golden regen.

## Verified

- **`tests/spotting.test.ts`** (4):
  - **Firebreak jump (A/B, seed sweep).** Dry timber split by a *nonburnable*
    firebreak (an absolute barrier — the surface fire can never enter it), a
    burning wall parked upwind, strong east wind. **With** spotting the downwind
    field ignites for every seed; **without** it the far side stays stone cold —
    proving the crossings are embers, not the front leaking across.
  - **Downwind directionality.** Breaks on both sides of the source; only the
    downwind (east) field catches embers, the upwind (west) one stays cold.
  - **Determinism.** Same seed → byte-for-byte identical `fire`, with a guard that
    spotting actually fired (non-vacuous).
- Full suite **119/119**, typecheck clean, `npm run frame` renders.
- Ad-hoc probe: the firebreak scenario ignites ~100–124 far-field cells per seed
  (out of 208) — a strong, non-marginal signal, so the test is not a tuning hostage.
- **Not dramatic in the default browser demo** — spotting is punctuation on an
  *intense, timbered, wind-driven* front; the gentle seed-1337 demo burns slowly
  (Rothermel ROS on 30 m cells), so spot fires are rare there. Verify via the test.

## Documented deferrals (sandbox scope — not this step)

- **Real fireline-intensity-driven ember production.** The launch rate uses canopy
  as an intensity proxy, not Byram's `firelineIntensity` (which `surfaceSpread`
  already returns). Upgrading = the fire model writes a per-cell intensity layer
  and spotting reads it — additive, behind the same seam, no rewrite.
- **Multiple brands per cell per tick / brand size classes / in-flight burnout.**
  One ember per cell per tick is enough to seed spot fires; a Poisson count and
  size-dependent range are cheap future refinements.
- **`IgnitableEntity` ember reception.** Handoff §"fuel-at-risk" wants structures
  to catch embers too. Entities are still an empty list in this phase; spotting
  currently ignites *cells* only. Wiring embers → entities is a Phase-4 firefighting
  concern (structure triage), not this step.
- **Terrain/plume-driven loft direction** beyond mean wind + jitter — CFD-adjacent,
  against handoff §2.1.

## Phase 3 status

With spotting landed, **Phase 3 (dynamic world) is complete**: moisture dynamics
([`phase-3-moisture-dynamics.md`](./phase-3-moisture-dynamics.md)), dynamic wind
([`phase-3-dynamic-wind.md`](./phase-3-dynamic-wind.md)), and spotting (this doc).
Next up the roadmap: **Phase 4 — firefighting doctrine** (suppression agents,
containment lines, the `ISuppressionAgent` seam; `IgnitableEntity` structures).
