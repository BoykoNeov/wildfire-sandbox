# Phase 2 — Science Anchor (plan)

**Goal (roadmap §6, handoff §4.2):** replace the Phase-1 CA's hand-tuned spread
coefficients with **science-derived rates of spread**. The fire front speed
should come from the **Rothermel surface-spread equations** fed by **standard
Anderson-13 fuel models** and a physically-meaningful **moisture layer**. Add a
**terrain editor** (paint tools) so scenarios can be authored.

This stays inside the scope guardrails: science-grounded, not validated/predictive
(handoff §1, §2.1). Rothermel *is* the operational surface science — exactly the
"realism sweet spot" the handoff calls for.

## Deliverables (verifiable gates)

Each must be runnable/testable before the next, per the roadmap discipline.

1. **`src/sim/rothermel.ts`** — a *pure* module (no world state) computing
   no-wind/no-slope reaction → spread rate `R0`, then wind/slope factors, giving
   `{ ros, reactionIntensity, firelineIntensity, flameLength }`. Unit-tested
   against published BehavePlus / textbook values.
2. **`src/sim/anderson13.ts`** — the 13 standard fuel models as data +
   `Anderson13FuelModel implements IFuelModel`. Widen `FuelParams` to carry the
   physical descriptors Rothermel needs.
3. **Moisture semantics** — give the existing `layers.moisture` (Uint8 0–255) a
   real meaning via a byte↔fraction convention (linear `0–255 ↔ 0.0–1.0`, a
   **dead**-fuel moisture fraction); the model reads a moisture *fraction*, the
   editor writes bytes. See **D6** for the encoding rationale and the moisture
   upgrade ladder. (Moisture *dynamics* — drying/wetting — stay in Phase 3;
   Phase 2 only makes the layer physical + paintable.)
4. **`src/sim/rothermelFireModel.ts`** — a new `IFireModel` (CA driven by
   Rothermel ROS) swapped in behind the seam; `CaFireModel` stays as the Phase-1
   reference. Acceptance test: measured front speed on a homogeneous field
   matches the analytic Rothermel ROS within tolerance.
5. **Terrain editor** — brush-based paint tools over elevation/fuel/moisture/
   canopy, wired in `main.ts`. Writes layer bytes only; the sim is untouched.

## Architecture fit (do not break the invariants)

- **Additive, not surgical.** New `IFuelModel` and `IFireModel` implementations
  live alongside the Phase-1 ones; `main.ts` wires the new pair. The seams
  (`getParams`, `step(world, dt)`) are unchanged in shape.
- **Rothermel is a pure function module**, independent of `WorldState` and the
  CA. This is what makes it unit-testable against published values and keeps the
  science isolated from the spread bookkeeping.
- **Systems still talk only through layers.** The editor and weather write
  layers; the fire model reads them. No system calls another (handoff §3.1).
- **Determinism.** See the dedicated section below — this is the hard constraint.

## Design decisions to settle here

### D1 — Widen `FuelParams`, keep one `getParams` seam
Add the Rothermel physical descriptors to `FuelParams` (canonical representation):

| field | meaning | unit (native imperial) |
|-------|---------|------------------------|
| `burnable` | nonburnable cells never ignite (kept) | — |
| `load` (`w0`) | oven-dry fuel load, by size class (1-hr/10-hr/100-hr dead + live) | lb/ft² |
| `sav` (`σ`) | surface-area-to-volume ratio (characteristic, or per class) | ft⁻¹ |
| `depth` (`δ`) | fuel bed depth | ft |
| `mx` | dead-fuel moisture of extinction | fraction |
| `heat` (`h`) | low heat content (≈ 8000 default) | BTU/lb |

`BasicFuelModel` keeps its Phase-1 `spreadRate`/`burnDuration` fields (mark them
legacy); `Anderson13FuelModel` fills the physical fields. The Rothermel fire
model reads the physical fields, the Phase-1 CA reads the legacy fields — both
satisfy the same `IFuelModel` interface.

### D2 — Units: compute Rothermel in native imperial, convert at the boundary
The world is metric (`cellSize` m, wind as `windU/windV`). Rothermel's published
constants and all textbook test vectors are imperial (lb/ft², ft⁻¹, BTU/lb,
ft/min). **Compute internally in imperial using the published constants** (fewer
conversion bugs, lets us assert against textbook numbers directly), then convert
**ROS ft/min → m/s** once, at the module boundary. This makes the unit tests
trivially comparable to references.

### D3 — Midflame wind convention
Rothermel's wind factor `φw` needs **midflame wind speed (ft/min)**. The world's
`windU/windV` are a wind *field* (currently "cells/sec"). Define an explicit
conversion `worldWind → midflameWindSpeed (ft/min)` and the projection onto the
spread direction. Document the convention in `rothermel.ts`; flag that a real
20-ft-wind → midflame adjustment factor is a future refinement, not Phase 2.

### D4 — CA coupling: deterministic ROS-accumulation (front arrival), not RNG
Phase 1 ignites neighbors *probabilistically*. For Phase 2 the front speed must
*be* the Rothermel ROS, so use a **deterministic spread-progress accumulator**:

- Add a per-cell `Float32` progress layer (or reuse a scratch buffer).
- Each tick, for each unburned cell, accumulate from ignited neighbors:
  `progress[i] += max over ignited neighbors of (ROS_dir / (dist · cellSize)) · dt`,
  where `ROS_dir` is the Rothermel ROS evaluated for cell `i`'s fuel/moisture with
  wind+slope projected onto the neighbor→cell direction.
- When `progress[i] ≥ 1`, the cell ignites. Burnout uses fuel residence time
  (derived from `σ`, Anderson/Albini) instead of the hand-tuned `burnDuration`.

This removes RNG from spread entirely (front speed is now an *observable* equal
to ROS — the acceptance test), and is the faithful "CA timing comes from
Rothermel" reading of handoff §4.2. Optional organic-perimeter stochasticity can
return later as a small modulation; it is **not** Phase 2.

> Alternative considered: keep the probabilistic CA and just feed `ROS` into the
> ignition probability. Rejected as the primary because front speed would no
> longer equal ROS, killing the clean science-check acceptance test.

#### D4 amendment (settled during step-4 implementation, commit `<this>`)
The first sketch above summed over *burning* neighbors. Implementation surfaced
two flaws; both are fixed by the wording now shown above. Recorded here so the
change is not a silent reversal:

1. **`max`, not `Σ`.** Summing overspeeds a planar front by `1+√2 ≈ 2.41×` (one
   cardinal + two diagonal sources), so measured speed ≠ ROS and the acceptance
   gate fails. The front physically arrives from the *fastest* direction (a
   min-arrival-time process); `max` is the forward-Euler discretization of exactly
   that, so it *serves* D4's goal rather than reversing it. Verified: `max` yields
   R0 along every neighbour ray (cardinal *and* diagonal — `dist` is in the
   denominator), ~8% slow only between rays.
2. **Sources = *ignited* (Burning OR Burned), not Burning only.** Flame residence
   `τ = 384/σ` is ~7 s for grass, but one 30 m cell takes ~20 min to cross at a
   realistic no-wind ROS (`R0(FM1, 6%) ≈ 0.024 m/s`). Burning-only sources make
   the front stall and die the instant a source burns out. A cell that has *ever*
   ignited keeps pushing the front (the arrival-time view); burnout then becomes
   purely the cosmetic flame duration, decoupled from spread.

Acceptance test (`tests/spread-ros.test.ts`): a **planar cardinal front** (not a
radius — `max` is octagonal between rays) over ~30 cells with crossing-time ≫ dt,
measured against `surfaceSpread`'s own R0; lands at ratio ≈ 0.97 (±5%, the ±1-cell
counting floor). Also asserts no spread at/above `Mx`, and Rothermel-path
determinism. Wind is read as **midflame m/s** (D3); slope clamped ≥ 0 (upslope-only).

### D5 — Anderson 13 catalog
Standard 13 models (Anderson 1982 — grass 1–3, shrub 4–7, timber 8–10, slash
11–13). Encode the published per-model parameters (loads by size class, SAV, bed
depth, moisture of extinction). Phase-1 `Fuel` ids (Grass/Brush/Timber) map onto
representative Anderson ids (e.g. Grass→1/3, Brush→4/5/6, Timber→8/9/10) so
existing terrain generation keeps working.

### D6 — Moisture encoding + the upgrade ladder
**Encoding (Step 3, permanent):** `layers.moisture` (Uint8) maps **linearly**:
`fraction = byte / 255`, `byte = round(clamp(fraction, 0, 1) · 255)`. So `0` =
bone dry, `255` = 100%. This is the one piece that is *not* cheaply reversible —
the editor writes bytes against it and saved scenarios encode it — so keep it
honest and linear. **Do not** bias the byte into a "realistic band" (e.g.
0–40%) for resolution or playability: that hides a nonlinearity from every
future reader and the editor. If generated terrain burns poorly because cells
sit near/above their moisture of extinction, fix it by writing **lower bytes in
`terrain.ts`** (Step 4 tuning), never by distorting the byte→fraction meaning.

The convention is checked: the current generator writes `6..52` for burnable
cells (`terrain.ts:113`), which under linear encoding is `2.4%–20%` — a dry
dead-fuel range that mostly sits *below* typical `Mx` (0.12–0.40) so the
Rothermel front can carry (this is the Step-4 moisture tuning, see the D6 lever
note above). Lives in `src/core/moisture.ts` (`byteToFraction` /
`fractionToByte`).

**This layer is DEAD-fuel moisture only.** 0–1.0 is ample for dead fuel (`Mx`
tops out at 0.40). Live fuel moisture routinely runs 100–300%, so it will *not*
fit this 0–1.0 byte — when the dead/live split lands it needs its **own**
representation (a separate layer / encoding), not this one. Do not reuse this
layer for live moisture.

**The upgrade ladder** — what gets more elaborate later, and how expensive each
is. The architecture is staged so these are additive, but they are *not* equally
cheap; label honestly:

1. **Single dead moisture → per-class dead moisture (1-/10-/100-hr apart)** —
   *genuinely model-side / data-distribution only.* `rothermel.ts` already lets
   each `FuelParticle` carry its own `moisture`; `deadFuelBed()` currently sets
   them equal (`anderson13.ts:103`). Upgrade = change how `deadFuelBed()`
   distributes moisture (a coarse-fuel offset from the painted fine moisture, or
   independent per-class layers). No change to the pure Rothermel math, no
   encoding change. Cheap, deferrable, no scheduled home needed.
2. **Dead-only bed → dead/live two-category split** — ⚠️ *NOT "model-side only."*
   Only the catalogue *data* is already carried (`anderson13.ts` keeps live
   loads/SAVs faithfully). The *computation* is single-category: `rothermel.ts`
   has one `moistureOfExtinction`, computes one characteristic moisture and one
   `etaM` (`rothermel.ts:280-284`). The split requires extending the **pure
   Rothermel module** to the two-category 1972 form — live moisture of extinction
   (`Mx_live = 2.9·W·(1 − M_dead/Mx_dead) − 0.226`), separate dead/live load
   weighting and moisture damping, **and its own published test vectors** — plus
   a live-moisture input (its own representation, per above). This is a
   substantial step **comparable in size to Step 4**, not a fractional increment.
   It is **unblocked by Step 3** (its precondition — a physical moisture layer —
   is exactly Step 3) and can land any time after; it does **not** gate a
   runnable Rothermel fire model (Step 4 runs fine dead-only). **FM4/FM5 stay out
   of the Step-5 fuel picker until this lands** (dead-only halves FM5, drops FM4
   ~31% — see `anderson13.ts` header).
3. **Static moisture → drying/wetting dynamics** — Phase 3, additive. A new
   system *writes* the byte layer over time from weather; the Step-3 encoding is
   read unchanged. See `docs/plans/phase-3-moisture-dynamics.md`.

## Determinism (the hard constraint)

`tests/determinism.test.ts` asserts a seed reproduces a run byte-for-byte; no
`Math.random()` allowed.

- The Rothermel path is **pure arithmetic** over typed arrays — deterministic by
  construction. D4 removes RNG from spread, so reproducibility is trivially
  preserved.
- Float32 accumulation is deterministic for a fixed iteration order and `dt`
  schedule (no parallelism, no reordering) — keep the fixed row-major sweep and
  double-buffering pattern from `CaFireModel`.
- **Golden values will change** because the fire model changes. Plan: the
  determinism test should assert *self-consistency* (same seed twice → identical)
  rather than a frozen golden hash, OR regenerate the golden when the Rothermel
  model lands and note it in the commit. Confirm which before editing the test.

## Proposed file layout

```
src/sim/rothermel.ts            pure Rothermel ROS / intensity / flame length
src/sim/anderson13.ts           the 13 fuel models + Anderson13FuelModel
src/sim/rothermelFireModel.ts   ROS-accumulation CA (new IFireModel)
src/core/moisture.ts            byte↔fraction conversion helpers (or fold into grid)
src/editor/                     brush paint tools over layers (UI, decoupled)
src/models/IFuelModel.ts        widen FuelParams (D1)
tests/rothermel.test.ts         analytic checks vs published values
tests/spread-ros.test.ts        front speed on homogeneous field ≈ analytic ROS
tests/determinism.test.ts       updated per the determinism section
```

## Sequencing

1. ✅ `rothermel.ts` + `tests/rothermel.test.ts` — the anchor, zero dependencies.
   *(done — commit `ce3d2a6`; primitives cross-checked vs emxsys/behave.)*
2. ✅ Widen `FuelParams`; `anderson13.ts` + `tests/anderson13.test.ts`.
   *(done — all 13 models transcribed from `firelab/behave`; net-load convention
   and 10-/100-hr SAVs source-confirmed; live fuel carried but dead-only bed.)*
3. ✅ Moisture byte↔fraction convention (D6): `src/core/moisture.ts`
   (`byteToFraction`/`fractionToByte`, linear) + `tests/moisture.test.ts`;
   document `layers.moisture` as **dead**-fuel moisture. The bed keeps a single
   dead moisture (no change to `deadFuelBed`'s shape). *(done — commit `c67e093`.)*
4. ✅ `rothermelFireModel.ts` + `spread-ros.test.ts`; wired into `main.ts` (+ the
   `renderFrame` smoke tool). *(done — `max`/ignited-source ROS-accumulation CA;
   front speed matches analytic R0 within ~5%; Rothermel-path determinism added;
   terrain moisture lowered to 6..52 per §D6 so the front carries. See the D4
   amendment above. Runs dead-only — the dead/live split is not a prerequisite.)*
5. Terrain editor (independent — can run in parallel with 1–4 or land last).

**Out-of-band — Dead/live two-category split (unblocked by Step 3).** *Not*
numbered into the 1→5 flow because it is independent of Step 4/5 ordering: its
only precondition is the physical moisture layer (Step 3). Substantial — extend
the pure `rothermel.ts` to the two-category 1972 form + a live-moisture
representation + its own test vectors (D6 item 2), then ungate FM4/FM5 in the
picker. Comparable in size to Step 4; land any time after Step 3.

**Deferred, no home needed — per-class dead moisture** (1-/10-/100-hr apart): a
cheap model-side tweak to `deadFuelBed()` distribution whenever wanted (D6
item 1). Not on the critical path.

Each step typechecks + passes tests before the next (Conventional Commits).

## Open questions for the user

- **Editor priority** — land it last (after the science core) or in parallel?
- **Determinism test** — switch to self-consistency, or keep a regenerated
  golden hash?
- **Phase-2 fuel id mapping** — *partly settled in step 2:*
  `Anderson13FuelModel.getParams` takes **native Anderson numbers 1–13** (0/unknown
  → nonburnable), so the catalogue is self-contained. The remaining open part is
  the terrain side: keep the 3 generic terrain ids remapped onto representative
  Anderson numbers, or expand terrain generation to place all 13? Deferred to the
  step-4 `main.ts` wiring.
