# Phase 6 — Science hurdles (crown fire, wind reference, intensity) + Phase-5 close-out

> **Status: LANDED.** Phase 5's remaining slices (5a stats HUD, 5b scenarios)
> are done in the same pass; 5c save/load stays deferred (plan decision #5).

**Goal:** close the gaps between what the handoff *designed* and what the sim
*computed*. Three were load-bearing for "science-grounded":

1. **Crown fire** (handoff §2.1) was designed as "two coupled surface layers
   with a transition threshold" and never built — the canopy layer only served
   spotting and the aerial-drop falloff.
2. **Wind reference height** (Phase-2 plan §D3) treated the world wind as
   midflame wind, "a future refinement". Reported winds are 20-ft winds; under a
   canopy the surface fire sees a fraction of them. Ignoring that overdrives
   timber fires by 3–10×.
3. **Fireline intensity was computed and thrown away.** Rothermel returns it;
   nothing stored it, so nothing (crown initiation, ember production, the
   renderer) could read it.

Everything here stays inside the guardrails: operational models, a transition
criterion plus a correlation, no plume physics, no validation claims.

---

## What shipped, in commit order

### 1. `layers.intensity` — fireline intensity as an output layer
The Rothermel fire model records Byram's intensity (kW/m) of the fastest
arriving direction when a cell ignites; externally-lit cells get their head-fire
value on the first burning tick. **Only the fire model writes it** (Handoff §3.1);
the CA leaves it at 0. `tests/intensity.test.ts`.

### 2. Wind adjustment factor — `windReference: 'midflame' | 'open'`
`src/sim/windAdjustment.ts` (Albini & Baughman 1979 / Andrews 2012) +
`src/sim/canopyStand.ts` (the scenario-level canopy structure the per-cell byte
modulates). Delivered as an **option, default `'midflame'`**, so the settled §D3
convention and every existing test are untouched; the presets opt into `'open'`
and are authored from reported wind speeds. `tests/windAdjustment.test.ts`
reproduces the BehavePlus WAF table.

**Design note — why the surface WAF backs out the open wind under `'midflame'`.**
The Rothermel-1991 crown rate needs the 20-ft wind. When the layer is already
midflame, the model divides by the surface fuel's *unsheltered* WAF to recover
it. Under `'open'` the layer is used directly. Documented on `openWind()`.

### 3. Crown fire — `src/sim/crownFire.ts` + `layers.crown`
Van Wagner (1977) I_0 and RAC, Rothermel (1991) `R_active = 3.34·R_FM10(0.4·U₂₀)`,
Van Wagner-1993 / Finney-1998 crown fraction burned blending rate and intensity.
Evaluated per neighbour direction *inside* `step()` (no new seam, no per-cell
virtual calls); the FM10 proxy bed is prepared once per crown candidate. Spotting
reads the crown layer and multiplies launch rate and loft for torching / running
crowns (surface state unchanged → existing spotting tests untouched).
`tests/crownFire.test.ts`.

**Decision — crown fire defaults ON.** A stand with canopy crowns when it
should. Opt out with `crownFire: false` for a surface-only model.

**Decision — canopy byte semantics tightened (data fix, not a science change).**
The WAF made an existing inconsistency visible: brush was painted canopy 90,
which crossed the sheltering threshold and cut its wind as if a 20 m overstory
stood over it, while chaparral's shrub crowns are already its Anderson fuel bed.
Brush is now 40 (below the shelter threshold and the crown floor
`MIN_CROWN_CBD = 0.05`); timber stays 200. Recorded here so it is not reversed.

### 4. Performance — O(front) sweep
Profiling showed ~12 ms/step at 256² with *no fire*: the 8-neighbour source scan
ran for every unburned burnable cell. A separable 3×3 dilation of the ignited
mask marks candidates first (same pre-tick buffer, same order → byte-identical
results). Rothermel factored into `prepareFuelBed` + `spreadFromIntermediates`.
Fire model 13.9 → 1.95 ms/step; gust field block-sampled 3.7 → 0.4 ms/step.

### 5. Phase 5b — scenarios
`src/scenario/scenario.ts` (`Scenario` data + `loadScenario`, the one builder
for `main.ts` and `tools/renderFrame.ts`) and `src/scenario/presets.ts`
(shifting-winds, grass-valley, timber-crown-run, rain-front). Additive support:
ambient keyframes on `DynamicWeatherProvider` (the Phase-3 deferral), a fuel
mapping on `TerrainFuelModel`, fuel-band / moisture-range terrain options.
`tests/scenario.test.ts`.

### 6. Phase 5a — stats HUD + visualisation
`src/sim/stats.ts` (pure, measured facts only — no "% contained"),
`src/ui/hud.ts` (scenario picker, pause / 30–300× wall-clock pacing, layer view
select, wind arrows, stats grid, burned-area sparkline), palette view modes,
crown-fire rendering (white-hot runs, grey ash scar, intensity heat ramp),
`src/render/overlay.ts` wind arrows. `tests/stats.test.ts`; browser-verified
with Playwright.

---

## Verification

- Full suite green (199 tests), typecheck clean, `npm run build` clean.
- `npm run frame -- timber-crown-run 3000 intensity` renders the crown run as a
  white-hot wedge; `-- rain-front 5400` renders a stalled fire.
- Determinism: the CA golden untouched; Rothermel-path, crown, spotting and
  scenario determinism each pinned.

## Deferred (still honest gaps — see `docs/science.md` §9)

- **Huygens / elliptical wavefront** — a later `IFireModel` behind the seam.
- **Per-class dead moisture** (1-/10-/100-hr) — `deadFuelBed` distribution tweak.
- **Live-moisture seasonal curve** — a scenario keyframe list, like ambient.
- **Intensity-driven ember production** — spotting now reads crown state; using
  `layers.intensity` directly for a continuous launch rate is the next step.
- **Per-cell canopy structure** (CBH/CBD/height layers) — with real-data import.
- **Phase 5c save/load** — plan decision #5, the user's scope call.
- **Structures / WUI → industrial** — handoff §5, the additive future phases.
