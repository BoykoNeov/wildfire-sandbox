# Wildfire & Firefighting Sandbox — working notes for Claude

A 2D top-down, **science-grounded** wildfire/firefighting sandbox in TypeScript +
HTML5 Canvas. The player is an incident commander. This is a sandbox, **not** a
validated/predictive tool — see the "Scope guardrails" below.

**Read [`wildfire-sandbox-handoff.md`](./wildfire-sandbox-handoff.md) before
changing direction on any architecture or scope decision.** Each decision there
was reasoned deliberately; don't silently reverse one. Planning docs for
in-flight features go in [`docs/plans/`](./docs/plans/). **[`docs/science.md`](./docs/science.md)
is the model card**: every equation, its source, the test that pins it, and the
list of what is deliberately not modelled — update it when the science changes.

## Commands

```bash
npm run dev        # Vite dev server — interactive sandbox
npm test           # Vitest, headless (npm run test:watch for watch mode)
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck + vite build
npm run frame      # headless: run the real sim, write frame.png (smoke check)
npm run frame -- timber-crown-run 3000 intensity   # any preset, steps, view
npm run profile    # ms/step per system + ms/frame per view (esbuild bundle → plain node)
npm run profile -- timber-crown-run 3000
```

**Profile only with `npm run profile`.** vite-node / vitest rewrite imports into
namespace-object property accesses that V8 cannot optimise in hot loops; timings
taken through them are 5–10× too slow and misattribute cost.

The browser takes `?scenario=<preset-id>`; presets live in `src/scenario/presets.ts`.

`tests/determinism.test.ts` runs the real terrain+CA pipeline and asserts a seed
reproduces a run byte-for-byte — that is what backs the "seeded RNG everywhere"
invariant below. Don't introduce `Math.random()`; it would break that test.

Each commit should typecheck and pass tests. Conventional Commits style.

## Architecture invariants (do not break these)

- **World state = plain data, no behavior** (`src/core/world.ts`): typed-array
  layers + entities + clock + seeded RNG.
- **Systems** (`src/core/system.ts`) run once per tick via `step(world, dt)` and
  read/write only their slice. **Systems never call each other** — they
  communicate through the data layers. (Replacing one model must not touch
  another.)
- **Headless sim / render split** (`src/core/simulation.ts`): the sim steps
  without drawing. The renderer reads world state; it never drives the sim.
- **Seeded RNG everywhere** (`src/core/rng.ts`): all randomness flows through
  `world.rng` so a seed reproduces a run byte-for-byte. Don't call `Math.random()`.
- **Abstract at the system/model boundary, never per-cell.** The seam is
  `IFireModel.step(world, dt)`; *inside* it, loop over typed arrays tightly. No
  per-cell virtual calls (they kill performance).

## The five seams (`src/models/`) + entity

`IFireModel`, `IFuelModel`, `IWeatherProvider`, `ISuppressionAgent`, `IRenderer`,
and the unifying `IgnitableEntity`. All exist as stubs from Phase 1 so later
phases are additive. The mounted pipeline is Rothermel (two-category, with the
wind adjustment factor and crown fire evaluated inside `step`) over Anderson 13
fuels; the Phase-1 `CaFireModel`/`BasicFuelModel` stay as the reference and back
the determinism golden.

**Output layers** (`intensity` kW/m, `crown` 0/1/2) are written **only by the
fire model** when a cell ignites; spotting, stats and the renderer read them.
**Pipeline order is load-bearing** and lives in one place, `loadScenario`:
`weather → moisture → crew → engine → aircraft → retardant → fire → spotting`.

**Renderer discipline** (`src/render/palette.ts`): `renderRGBA` is a pure
function of world state — animated effects (flicker, shimmer, smoke) derive from
`clock.time` + a cell hash, never `world.rng`. Static shading (hillshade,
contours) is cached per world; anything that paints `elevation`/`fuel` must call
`invalidateTerrainShading(world)` (the editor does via `onPaint`). Unit markers,
cursors and wind arrows draw on the screen-resolution overlay canvas
(`overlay.ts`), never on the pixel view.

## Layout

```
src/core/      world state, layers, rng, clock, system, simulation (the foundation)
src/models/    the five swappable seam interfaces + IgnitableEntity
src/sim/       pure science modules (rothermel, anderson13, emc, windAdjustment,
               crownFire, canopyStand) + systems (fire models, weather, moisture,
               spotting, suppression agents, retardant) + stats (pure)
src/gen/       terrain generation (seeded value noise)
src/scenario/  Scenario data + loadScenario (the ONE pipeline builder) + presets
src/render/    palette (shared colour composition, view modes, smoke, per-world shading cache),
               canvas renderer, overlay (wind arrows, unit glyphs, cursor on the crisp canvas)
src/editor/    browser-only terrain editor + suppression command shell
src/ui/        browser-only HUD (stats reader + run controls + legend + perf readout)
src/main.ts    browser entry: loadScenario + renderer + editor + command + HUD, wall-clock pacing
tools/         renderFrame.ts — headless PNG of any preset/view, same loader;
               profile.ts — per-system / per-view timings (run via `npm run profile`)
tests/         headless tests — simulation.test.ts is the architecture proof
docs/          science.md (model card), plans/ (per-phase plans + decisions)
```

Browser-only code (`editor/`, `ui/`, `main.ts`) is non-deterministic by design
and never enters the sim: it enqueues orders / paints layer bytes / reads state.

## Scope guardrails (from handoff §1, §2.1)

When unsure on realism: **science-grounded sandbox, not CFD, not predictive.**
- Simulation is **2.5D** (heightfield + stacked layers), not a 3D volume.
- Rendering is **2D top-down only** — no perspective camera, no 3D viz.
- **Interior/compartment fire is a separate project** — keep it out of this engine.
- Don't oversell behavior as validated prediction; it should *feel authentic and
  teach true things*, not claim to predict a real burn.

## Roadmap (handoff §6)

P1 core CA + seams ✅ → P2 Anderson 13 + Rothermel + moisture + editor ✅ →
P3 dynamic wind/rain/spotting ✅ → P4 firefighting doctrine ✅ → P5 polish
(5-viz ✅, 5a stats HUD ✅, 5b scenarios ✅, 5c save/load deferred) → P6 science
hurdles (intensity layer, wind adjustment factor, crown fire, perf) ✅ →
heat-driven ember production (spotting reads `layers.intensity` via Byram flame
length) ✅ → P7 visuals & performance part 1 ✅ (3–4× faster step, render cache,
smoke, contours, crisp overlays, legend, profiler) → P7 part 2 items A–C ✅
(amortised smoke, cached ground colour, compacted front list: the terrain frame
is 3.69 → 1.67 ms at 256², the fire model 1.94 → 1.07 ms/step at 512²; the
incremental dilation is deliberately NOT done — see item C) + item F ✅
(spot-fire flash on fresh isolated ignitions, HUD-toggleable). Next: P7 part 2
items D, E, G, H in `docs/plans/phase-7-visuals-performance.md` (bigger maps from
the URL — read item D's caveat: the data views still cost 10–17 ms/frame at 512²
— wind streamlines, HUD/profiler odds and ends), the honest gaps
in `docs/science.md` §9 (Huygens wavefront, per-class dead moisture,
live-moisture curve, intensity-driven ember loft), then the additive future
phases (WUI structures → industrial). Each phase must be runnable and verifiable
before the next.
