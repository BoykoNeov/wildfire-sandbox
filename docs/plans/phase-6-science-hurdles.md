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
- ~~**Intensity-driven ember production**~~ — **LANDED** (see the follow-up
  section below): the launch rate now reads `layers.intensity` through Byram
  flame length. Ember *loft distance* is still crown-tiered, and stays deferred.
- **Per-cell canopy structure** (CBH/CBD/height layers) — with real-data import.
- **Phase 5c save/load** — plan decision #5, the user's scope call.
- **Structures / WUI → industrial** — handoff §5, the additive future phases.

---

## Follow-up (landed after Phase 6): heat-driven ember production

The Phase-3 deferral "the launch rate uses canopy as an intensity proxy, not
Byram's `firelineIntensity`" is closed. `SpottingSystem` now reads the
`layers.intensity` the Phase-6 fire model writes and scales the launch rate by
Byram/Albini flame length `L = 0.45·I^0.46` (the existing `flameLength` in
`sim/rothermel.ts`), normalised against a 1000 kW/m reference front.

**Why flame length rather than intensity directly.** Flame length is the height
brands are lifted from, and the 0.46 exponent compresses the 10²–10⁵ kW/m range
these scenarios actually produce into a ≈0.5–8× launch band instead of a 1000×
one. Linear-in-intensity would peg a fierce brush front at one ember per cell
per tick — the structural ceiling — over a wide area, and the model would stop
discriminating at the top of its own range.

**Why canopy and the crown multiplier both survive.** Canopy keeps its *other*
role (brand availability and plume height — bark and cones, which grass has
none of). The crown multiplier stays because measured intensities say it must:
in `timber-crown-run`, within FM10 timber, surface fire records ~380 kW/m and
crowning cells ~700–900 kW/m — only ≈1.4× after flame length, against the ×3/×6
the launch boost applies. Crown-borne brands come out of the canopy, not out of
the fireline, so intensity does not see them; folding crowning into the heat
term alone would have gutted spotting in the flagship crown scenario.

**Zero-intensity fallback.** A burning cell with no recorded intensity uses the
reference rate exactly (ratio 1), not zero. Two cases need it: the legacy
Phase-1 CA pipeline has no intensity concept at all, and a brand that lands
*after* the fire model has already run this tick is unscored for exactly one
tick. Making that zero would mute CA-pipeline spotting entirely.

**Calibration measured, not guessed** (`timber-crown-run`, 3000 steps, per fuel
band and crown state):

| band | recorded intensity (median kW/m) | flame-length factor | ember chance/tick @10 m/s |
|---|---|---|---|
| grass FM2 (canopy 0.04) | 5 073 | 2.1 | 0.016 (was 0.008) |
| brush FM4 (canopy 0.16) | 78 839 | 7.5 | 0.21 (was 0.03) |
| timber FM10 surface (canopy 0.78) | 381 | 0.64 | 0.10 (was 0.16) |
| timber FM10 active crown | 676 | 0.83 | 0.54 (was 0.61) |

The timbered cases land almost exactly where they were — that reference front is
chosen so they do — while a fierce brush run now spots ~7× more, which is the
behaviour change the step is for. Nothing saturates: the worst observed per-tick
ember chance is 0.63, the same value the canopy-proxy version already produced.

**Whole-run effect** (ignited cells after 3000 steps, before → after): 
`timber-crown-run` 19 657 → 20 566 (+4.6%), `grass-valley` 11 794 → 14 788
(+25%), `shifting-winds` 393 → 394 (unchanged). The crown scenario barely moves
because its timber is exactly what the reference front is calibrated to; the
grass valley grows because a 11 500 kW/m grass front now spots ~3× as often and
grass carries the resulting seeds fast; the weak, damp scenario is untouched.

**Verified.** Full suite 201/201 green (2 new tests in `tests/spotting.test.ts`:
launch rate scales ≈8× from a 300 to a 30 000 kW/m front, matching the ≈8.3×
`L ∝ I^0.46` predicts; an unscored cell is byte-identical to a 1000 kW/m one).
Typecheck clean. `npm run frame -- timber-crown-run 3000 intensity` still renders
a coherent wedge with a speckled downwind edge, not a rash of spot fires. The
determinism golden uses the CA pipeline without spotting and is untouched.
