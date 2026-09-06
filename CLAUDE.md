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
wind adjustment factor and crown fire evaluated inside `step`) over the 53
standard fuel models — Anderson 13 at ids 1–13, Scott & Burgan 40 at 101–204,
one union lookup; the Phase-1 `CaFireModel`/`BasicFuelModel` stay as the reference
and back the determinism golden.

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
src/sim/       pure science modules (rothermel, fuelCatalogue + anderson13 + scottBurgan40,
               emc, moistureScenarios, windAdjustment, crownFire, canopyStand, spotDistance)
               + systems (fire models, weather, moisture, spotting, suppression agents,
               retardant) + stats (pure)
src/gen/       terrain generation (seeded value noise)
src/scenario/  Scenario data + loadScenario (the ONE pipeline builder) + presets
src/render/    palette (shared colour composition, view modes, smoke, per-world shading cache),
               canvas renderer, overlay (wind arrows, unit glyphs, cursor on the crisp canvas)
src/editor/    browser-only terrain editor + suppression command shell
src/ui/        browser-only HUD (stats reader + run controls + legend + perf readout)
src/main.ts    browser entry: loadScenario + renderer + editor + command + HUD, wall-clock pacing
tools/         renderFrame.ts — headless PNG of any preset/view, same loader;
               profile.ts — per-system / per-view timings (run via `npm run profile`);
               sb40Fixture.mjs — regenerates the Scott & Burgan parameter fixture
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
2.25× the burned area and 1.60× the mean fireline intensity at one hour (both
re-measured after the loft-distance step below). →
**Intensity-driven ember loft distance** ✅ (`docs/science.md` §6): how far a
firebrand carries was wind × canopy × crown tier with no heat in it, so a
smouldering front and a fierce one threw brands equally far. It is now **Albini's
maximum spotting distance** for a wind-driven surface fire (new pure module
`src/sim/spotDistance.ts`, transcribed from BehavePlus `spot.cpp` and pinned
against an independent transcription of the same C++), read off the recorded
fireline intensity the launch rate has used since Phase 6: the plume lofts a
brand to `z = 1.055·√(f·I_B)` feet and it drifts downwind over the canopy. At
10 m/s under 15.7 m of canopy that is 339 m for a 1000 kW/m front against 1335 m
for a 30 000 kW/m one. Two things came with it. **Canopy changed meaning**: it is
no longer a plume-height proxy but three separate things — brand availability,
brand durability, and Albini's downwind cover height, the last of which pushes
the *other* way (less cover to catch a brand ⇒ longer throw). And the **brand
survival term is load-bearing, not a fudge**: Albini's relations describe a brand
that survives the flight, so without a burnout stand-in an intense grass fire
spots like crowning timber — measured 1.6 km throws and double `grass-valley`'s
burned area. Keyed to canopy (bark plates and cones survive minutes, grass brands
seconds) it holds the shipped presets within a few percent of where they were
(`timber-crown-run` 16 093 → 16 474 cells at one hour) while the *range* of
distances opens up with intensity. The crown boost moved from distance to
firebrand height, which is where crowning physically acts. `timber-crown-run`'s
golden is recomputed; the old loft formula is gone, not flag-restorable.
**P10 Scott & Burgan 40** ✅ (`docs/plans/phase-10-scott-burgan-40.md`): the fuel
vocabulary goes from 13 models to 53. All 40 standard Scott & Burgan (2005) models
at their published numbers 101–204, transcribed from the same BehavePlus
`fuelModels.cpp` the Anderson 13 came from, served through one union lookup
(`STANDARD_FUEL_MODELS`) beside the 13 at 1–13 — the number ranges are disjoint,
so a scenario may mix them and nothing needs a mode flag. **No Rothermel maths
changed, no new system, no new layer**; the fuel *layer* stays the generic 0–4
terrain classes, so palette, editor, CA path and the determinism golden are
untouched. `RothermelFuel` gains a `dynamic` flag and `dynamicHerbLoad` becomes
three-state — omitted follows each model's own flag (BehavePlus's behaviour, and
byte-identical for all 13 static Anderson models), `true` forces it on (the
Phase-9b extension), `false` forces it off. The transcription is pinned against a
fixture **generated from the C++** (`tools/sb40Fixture.mjs`), not retyped.
**The measurement, which was predicted before it was taken and this time held:**
green → cured moves GR2's R₀ ×50.2 and its fireline intensity ×546, against FM2's
×1.32 / ×1.23 — and the *load* half, the minor and backwards lever in the Anderson
13, is here the dominant one (GR2 ×19.4 on R₀ alone). It still flips sign where the
herbaceous share is small (SH9 ×0.895), so §3c's mechanism is intact; it just
usually points the other way. Strongest form: for a dynamic grass model the
transfer is a **precondition, not an enhancement** — without it GR2 stays under
0.2 ft/min at every season and the season pair burns 0.2 ha instead of 92.9.
And a fully green landscape simply does not carry fire (ignition dead in five
cells at greenness ≥ 0.8), which is why the **season pair moved to GR2/GS2/TU5
with its green member at greenness 0.6, not 1**, and was re-measured: 8.26× the
burned area and 2.47× the mean fireline intensity at one hour, against the old
pair's 2.25× / 1.60×. Other presets and the default terrain mapping (FM1/FM6/FM9)
are unmoved on purpose — every measured number in `docs/science.md` was taken
against them.
**P11 the smooth wavefront, Stages 0–1** ✅
(`docs/plans/phase-11-smooth-wavefront.md`): the fire can now be carried as a
**polygon of marker points** that each move by Richards' (1990) elliptical growth
equations — FARSITE's mechanism, transcribed from the FARSITE 4 C++ because
BehavePlus is a *point* model library with no propagation in it at all — and
painted into the same `fire`/`intensity`/`crown` layers. Select it with
`spreadEngine: 'huygens'` on a scenario; **`'raster'` is still the default** and
is byte-identical, so no measured number in `docs/science.md` has moved.

Three things worth carrying forward. **The spread law did not change**: FARSITE's
`lb_ratio` is character-for-character our `lengthToBreadthRatio` and its Alexander
head/backing ratio is our `backingRate` in disguise, so Phase 11 changes only how
the front is *carried* — established by identity, not by hoping two sources agree.
**Stage 0 came first and was byte-identical**: everything the raster model knew
about a *cell* (bed caches, the WAF, the ellipse, the crown transition) moved to
`src/sim/surfaceBehaviour.ts` before a line of Huygens code was written, so the
two models cannot drift; the golden hash and 0.594 → 0.574 ms/step are the gate on
that (0.561 after Stage 1 added a marker-path method to the same shared object —
`npm run profile`, `shifting-winds` at 256², idle machine). And **the measurement had to separate the front from the grid**: the front
itself comes out at 1.0022 max/min windless (against the raster's 1.080 on the
same field) and within 4.4 % on length-to-breadth out to 5 m/s, but read back out
of the `fire` layer the same run measures 1.050 — because at a 30-cell radius on
30 m cells, one cell is 3 %. The phase would have looked like it missed its own
headline prediction without that distinction.

Still to do: **merging** two perimeters that have grown together (Stage 2 — and
until it lands the marker front is not usable on any preset with spotting, which
throws multiple concurrent perimeters from the first ember), **crossover/loop
removal** (Stage 3), then the argued call on whether the default flips. Burnable
enclaves are declared out of scope for the phase.

Next: Phase 11 Stages 2 and 3 — then the additive future phases (WUI structures →
industrial). Each phase must be runnable and verifiable before the next.

One scope note carried by `?size=`: the terrain generator samples in normalized
coordinates, so a bigger map is the same landscape spread over more ground —
slopes at 512 are about half as steep as at 256. See item D in
`docs/plans/phase-7-visuals-performance.md` for the alternative and why it was
not taken unilaterally.
