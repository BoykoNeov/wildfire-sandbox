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
   real meaning via a byte↔fraction convention; the model reads a moisture
   *fraction*, the editor writes bytes. (Moisture *dynamics* — drying/wetting —
   stay in Phase 3; Phase 2 only makes the layer physical + paintable.)
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
- Each tick, for each unburned cell, sum contributions from burning neighbors:
  `progress[i] += Σ (ROS_dir / (dist · cellSize)) · dt`, where `ROS_dir` is the
  Rothermel ROS evaluated for cell `i`'s fuel/moisture with wind+slope projected
  onto the neighbor→cell direction.
- When `progress[i] ≥ 1`, the cell ignites. Burnout uses fuel residence time
  (derived from `σ`, Anderson/Albini) instead of the hand-tuned `burnDuration`.

This removes RNG from spread entirely (front speed is now an *observable* equal
to ROS — the acceptance test), and is the faithful "CA timing comes from
Rothermel" reading of handoff §4.2. Optional organic-perimeter stochasticity can
return later as a small modulation; it is **not** Phase 2.

> Alternative considered: keep the probabilistic CA and just feed `ROS` into the
> ignition probability. Rejected as the primary because front speed would no
> longer equal ROS, killing the clean science-check acceptance test.

### D5 — Anderson 13 catalog
Standard 13 models (Anderson 1982 — grass 1–3, shrub 4–7, timber 8–10, slash
11–13). Encode the published per-model parameters (loads by size class, SAV, bed
depth, moisture of extinction). Phase-1 `Fuel` ids (Grass/Brush/Timber) map onto
representative Anderson ids (e.g. Grass→1/3, Brush→4/5/6, Timber→8/9/10) so
existing terrain generation keeps working.

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

1. `rothermel.ts` + `tests/rothermel.test.ts` — the anchor, zero dependencies.
2. Widen `FuelParams`; `anderson13.ts`.
3. Moisture byte↔fraction convention.
4. `rothermelFireModel.ts` + `spread-ros.test.ts`; wire into `main.ts`; update
   determinism test.
5. Terrain editor (independent — can run in parallel with 1–4 or land last).

Each step typechecks + passes tests before the next (Conventional Commits).

## Open questions for the user

- **Editor priority** — land it last (after the science core) or in parallel?
- **Determinism test** — switch to self-consistency, or keep a regenerated
  golden hash?
- **Phase-2 fuel id mapping** — keep the 3 generic terrain ids mapped onto
  Anderson models, or expand terrain generation to place all 13?
