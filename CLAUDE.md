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
src/sim/       pure science modules (rothermel, anderson13, emc, moistureScenarios,
               windAdjustment, crownFire, canopyStand) + systems (fire models, weather, moisture,
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
incremental dilation is deliberately NOT done — see item C) + items F ✅
(spot-fire flash on fresh isolated ignitions, HUD-toggleable), E ✅ (animated
wind streamlines; the wind button cycles off → arrows → streamlines), D ✅
(`?size=` maps, 64–1024, after extending the unburned-colour cache to all six
views: the data views went 12–15 → 2.8–3.7 ms/frame at 512²) and H ✅ (contours
toggle, view state in the URL, profiler budget line). G (a WebGL renderer) is
written down but **not needed** — nothing misses the frame budget at 512². →
**P8 elliptical fire shape** ✅ (`docs/plans/phase-8-elliptical-spread.md`): wind
and slope now combine **once per cell, as vectors**, into a head rate and a
direction of maximum spread, and every other direction is read off the
Anderson-1983 spread ellipse at its focus. Expect visibly different fires than in
Phase 7 — longer, much slower at the back, and **wider at the flanks** (the flank
rate is 4–6× R₀, not R₀). One Rothermel evaluation per cell replaces eight.
`spreadShape: 'perDirection'` restores the Phase-2 law. →
**P8b 16-ray template** ✅ (same plan doc, §"Phase 8b"; reverses that plan's own
"keep the 8-neighbour template" decision): the front now
travels along 16 rays, the 8-ring plus the eight knight moves at ±26.57°/±63.43°,
which land near the spread ellipse's widest point. Two things came with it.
**Every knight move tests the two cells it steps over** — a √5 step would
otherwise hop a one-cell containment line and silently void the Phase-4 doctrine
(measured: 299 cells leak without the gate, zero with it). And **every ray gets
its own arrival accumulator**: a 16-ray template on the Phase-2 single accumulator
runs **1.45× too fast**, because a cell takes credit from its knight neighbour two
columns back and then adds the cardinal rate on top. Result: length-to-breadth
error at 4–5 m/s drops from +39%/+61% to +4%/+28%, the windless fire goes from
1.17 to 1.09 max/min anisotropy and no longer overshoots R₀ anywhere, and the fire
model costs ~1.7× (1.53 vs 0.91 ms/step at 256² — still a fifth of the frame
budget). `spreadTemplate: 'ring8'` restores the Phase-2..8 law byte-for-byte. →
**P9 fuel moisture** ✅ (`docs/plans/phase-9-fuel-moisture.md`): the bed was being
handed one dead moisture and one live moisture where the science asks for three
and two. Now `deadFuelBed`/`fuelBed` take an optional `BedMoisture`, and the fire
model has `dead10hMoisture`/`dead100hMoisture` plus a `greenness` knob (0 cured →
1 green) that sets live herbaceous and live woody apart along the BehavePlus
ladder. Both are **scenario constants, not layers, and not offsets from the fine
layer** — their timelags (10 h, 100 h, a season) all outrun a sandbox burn, so
what matters is the antecedent condition; an offset would make the logs chase the
grass through a rain pulse. Bed assembly only: no Rothermel math changed, no
encoding changed, no new system, and a prepared bed stays a pure function of
(fuel id, fine moisture byte) so the Phase-7 bed cache is untouched. Omitting
every new option reproduces the old bed byte-for-byte. Measured before it was
documented, and **smaller than it feels**: single-dead-class models (FM1/FM3)
cannot move at all, BehavePlus's own 6/7/8 triple moves the largest model 1.6 %,
and an extreme 6/15/25 ranges 0.996× (FM9) to 0.891× (FM13) on R₀ — but about
twice that on fireline **intensity** (0.811× FM13, 0.933× FM10), which is what
crown fire and ember production threshold on. `timber-crown-run` states its
coarse moisture now (golden recomputed); `grass-valley` says `greenness: 0`
instead of `liveMoisture: 0.6` (byte-identical, verified). →
**P9b curing's load half** ✅ (`docs/science.md` §3c): `dynamicHerbLoad` adds
BehavePlus's `dynamicLoadTransfer` — cured live-herbaceous load becomes a fourth
**dead** class at the live-herb SAV and the fine dead moisture, the fraction read
off the live herbaceous moisture already in use (so under the greenness curve it
is just `f ≈ 1 − g`, one season knob driving both halves). **Off by default**: it
is an *extension* of the Anderson catalogue, which BehavePlus itself gates behind
an `isDynamic` flag all 13 models fail, and every existing bed and the
`timber-crown-run` golden are byte-identical without it. Measured, and **it does
the opposite of the intuition**: only FM2 carries live herbaceous load at all, and
on FM2 fully cured the transfer takes R₀ to 0.957× and intensity to 0.841× —
because moving a class between categories changes no geometry, only which
extinction moisture damps it, and FM2's dead M_x is 15 % against a live M_x near
1044 %. So in *this* catalogue the load half is the minor lever and pulls against
the moisture half; it is the Scott & Burgan 40 that would make it dominant, and
that catalogue is still §9's deferral (the mechanic, its prerequisite, is now
done). Shipped with the **season pair** — `spring-green` / `late-season-cured`,
one landscape and one weather where `greenness` is the only field that differs:
2.34× the burned area and 1.59× the mean fireline intensity at one hour.
Next: the two remaining honest gaps in `docs/science.md` §9 — a smooth wavefront
(now Huygens; the raster route is spent) and intensity-driven ember loft distance
— then the additive future phases (WUI structures → industrial). Each phase must
be runnable and verifiable before the next.

One scope note carried by `?size=`: the terrain generator samples in normalized
coordinates, so a bigger map is the same landscape spread over more ground —
slopes at 512 are about half as steep as at 256. See item D in
`docs/plans/phase-7-visuals-performance.md` for the alternative and why it was
not taken unilaterally.
