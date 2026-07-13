# Phase 5 — Polish (visuals, stats HUD, scenarios)

> **Status: 5-viz IN PROGRESS · 5a/5b PLANNED · 5c (save/load) DEFERRED.**
> Phase 4 (firefighting doctrine) is complete. This is the plan for the roadmap's
> last core phase (handoff §6): "UI, scenarios, stats overlays, save/load (seeded
> RNG makes scenarios reproducible)."

**Goal (roadmap §6 "P5 polish"):** make the sandbox *legible and repeatable*
without touching the simulation. Everything in this phase is a **reader** of
world state or a **composer** of existing pieces — no new physics, no fire-model
surgery, no new layer semantics. The phase is done when a player can pick a
named scenario, watch the run with an honest stats readout, and the map itself
communicates terrain, fire behavior, and suppression at a glance.

Slices, each runnable and verifiable before the next (the 4a/4b/4c convention):
**5-viz visual polish → 5a stats HUD → 5b scenarios → (5c save/load, deferred).**

---

## The load-bearing design decisions

### 1. Everything in Phase 5 is read-only over the sim

The Phase-4 spine was *layer-only* (suppression writes shared layers, never a
model's private state). Phase 5 tightens that one notch: **its components write
nothing at all** into world state.

- The **palette/renderer** reads layers → pixels (already the invariant;
  handoff §3.1 "renderer never drives the sim").
- **Stats** are a pure function `computeStats(world): SimStats` — no DOM, no
  canvas, so it is headless-testable exactly like the fire models.
- The **HUD** is a browser-only DOM reader like `SuppressionCommand`'s gauge:
  it formats `SimStats` + agent getters each frame. Wired only in `main.ts`.
- A **scenario** is plain data consumed *before* the run starts; loading one
  builds a fresh world, it never mutates a live one.

The discriminating check for the phase: *does any Phase-5 component call a
system, or write a layer?* If yes, it's mis-designed.

### 2. Renderer effects must be deterministic reads — flicker comes from the clock, never the RNG

The visual pass adds life (fire flicker, glow). The trap: "random" flicker
drawn from `world.rng` would consume draws the sim expects and desync the
determinism golden. Rule: **renderers never touch `world.rng`.** Animated
effects derive from `world.clock.time` + a pure integer hash of the cell index
— fully deterministic, so the headless exporter (`tools/renderFrame.ts`)
renders the same PNG for the same seed+steps, and `npm run frame` stays honest
evidence.

Corollary: the golden test compares `fire` + `elevation` *layers*, not pixels,
so palette changes are free — but the shared-palette discipline (one `cellRGB`
/ one `renderRGBA` used by canvas *and* headless exporter) is what keeps the
browser and the PNG from drifting apart. The visual pass **strengthens** that
by moving the whole RGBA composition (per-cell color + glow post-pass) into
`src/render/palette.ts`, leaving both renderers as thin byte-copiers.

### 3. No fake "% contained" — report honest numbers or none

The scope guardrail says *don't oversell*. Real-world "containment %" is an
ICS judgment call (fraction of perimeter with completed control line that is
expected to hold). Deriving a single trustworthy number from the grid would
require perimeter tracing plus a hold-prediction we deliberately don't claim
to make. So the HUD reports **measured facts only**:

| Stat | Source | Unit |
|---|---|---|
| Sim time | `clock.time` | h:mm:ss |
| Actively burning | count of `fire == Burning` | cells + ha |
| Burned | count of `fire == Burned` | ha |
| Burnable landscape consumed | (burning+burned) / initially-burnable | % |
| Wind (at map center) | `windU/windV` at center cell | m/s + compass |
| Ambient | `env` temperature / RH / rain | °C, %, mm/h |
| Line cut | count of `fuel == CutLine` | m (× cellSize) |
| Retardant active | count of `retardant > 0` | cells |
| Engine water / tanker state | agent getters (as the gauge does today) | % / verb |

(ha per cell = `cellSize²/10 000` — 0.09 ha on the default 30 m grid.) A
*derived* front-geometry stat (e.g. fraction of the active front adjacent to
nonburnable/line/burned) may come later as a stretch, labeled as the geometry
fact it is — never as "containment" prediction.

### 4. One scenario loader shared by `main.ts` and the headless exporter

Today `main.ts` and `tools/renderFrame.ts` hand-wire the *same* pipeline
(world → terrain → ignition → weather/moisture/crew/engine/aircraft/retardant/
fire/spotting) and have already started to drift (different agent orders,
duplicated weather keyframes). 5b's core move: a `Scenario` descriptor —
**plain data** (seed, dims, cellSize, terrain opts, weather keyframes +
ambient, ignition points, agent roster with spawn/refill/base cells) — and one
`loadScenario(s): { world, systems, agents }` builder both entry points call.
The browser adds a selector UI on top; the exporter takes a scenario name.
Seeded RNG makes every preset byte-for-byte reproducible — that's the roadmap's
own parenthetical, delivered without any serialization code.

### 5. Save/load (5c) is deferred — the scope decision is the user's

Two designs were weighed: **(A) mid-run snapshot** (serialize all layers + RNG
internal state + every agent's private state; a tick-0 snapshot subsumes
scenario-save) vs **(B) scenario+seed replay** (light, but cannot reconstruct
hand-painted terrain edits or interactively-issued orders, both deliberately
outside the determinism boundary). Advisor review favored A for correctness
(replay has a real hole) with a byte-for-byte save-boundary test. Decision on
scope is deferred; nothing in 5-viz/5a/5b blocks on it, and 5b's `Scenario`
data type is the natural container either way.

---

## 5-viz — visual polish (this slice)

Renderer-only. All in `src/render/palette.ts` + thin renderer refactors +
page chrome. Zero sim writes; suite + golden must stay green untouched.

- **Hillshade:** Lambert lighting from elevation central differences (NW key
  light), replacing the flat `0.6 + 0.4·e/1000` brightness ramp. Terrain relief
  becomes readable — the whole reason a 2.5D heightfield exists.
- **Per-cell texture:** a small deterministic brightness jitter from an integer
  hash of the cell index, breaking up the flat fuel-band posterization.
- **Moisture tint:** unburned fuel shifts subtly brown when dry, green/dark
  when moist. Makes the *invisible layer that decides everything* visible —
  and water drops / engine knockdowns / drying wet-lines legible for free.
- **Fire by age + flicker:** burning cells colored on a white-yellow → orange
  → deep-red ramp by `burnElapsed` (young front hot, old flame dying), with a
  clock-driven flicker (decision #2). The front reads as a *front*, not a
  uniform orange blob.
- **Glow post-pass:** burning cells warm their immediate neighbors additively
  — a cheap bloom that makes the fire read at a glance. Lives in the shared
  `renderRGBA`, so the PNG gets it too.
- **Burned char variation + the live scar edge:** hash-varied char tone; and
  the scar *perimeter* smolders. Flame residence is seconds (τ = 384/σ) while a
  30 m cell takes minutes to cross, so at any instant only 1–3 cells are
  literally `Burning` — a front rendered only from `Burning` reads as blinking
  pixels. But in the mounted model Burned cells are **permanent spread sources**
  (§D4), so a burned cell still facing unburned burnable fuel is honestly *not
  dead*: it renders as a dim breathing ember rim. An edge against nonburnable
  (rock, water, a cut line) goes cold — a held line reads held; a merely-wetted
  edge keeps smoldering, which teaches the true thing: it resumes when it dries.
  Cells beside literal flames glow brighter still.
- **Water/rock:** water shaded by depth (elevation), rock keeps hillshade.
- **Chrome:** `index.html` header/frame/hint-bar; command-toolbar CSS unified.

**Verify:** `npm run typecheck` + full suite green (golden untouched — layers,
not pixels) + `npm run frame` PNG visibly improved (relief, front gradient,
glow) + browser smoke.

## 5a — stats HUD

- `src/sim/stats.ts` (or `src/core/stats.ts`): `computeStats(world, baseline)`
  pure function; `baseline` = initially-burnable cell count captured at load.
  One pass over the layers, no allocation in the hot path.
- `tests/stats.test.ts`: headless — known hand-built worlds produce exact
  counts; a live-Rothermel run's stats move in the right direction (burned
  monotonically ↑, burnable-consumed ↑).
- `src/ui/hud.ts`: browser-only DOM panel (style of `SuppressionCommand`'s
  toolbar), updated once per animation frame from `computeStats` + agent
  getters. Throttle: recompute stats every N frames if profiling demands.

**Verify:** stats tests green; HUD numbers move sensibly in a live run.

## 5b — scenarios

- `src/scenario/scenario.ts`: the `Scenario` interface (plain data, decision
  #4) + `loadScenario`.
- `src/scenario/presets.ts`: named presets — at minimum the current hardcoded
  demo ("Shifting Winds"), a grass-valley fast-mover, a timber/crown-heavy
  unit with spotting emphasis.
- Refactor `main.ts` and `tools/renderFrame.ts` onto `loadScenario` (drift
  ends). Browser gets a scenario selector (rebuilds world + systems + renderer
  + editor + command shell on switch).
- `tests/scenario.test.ts`: loading a preset twice yields byte-identical
  layers (the reproducibility promise); the default preset matches what
  `main.ts` used to hand-wire.

**Verify:** suite green; selector switches scenarios live in the browser;
`npm run frame -- <preset>` renders any preset.

## 5c — save/load (deferred; see decision #5)
