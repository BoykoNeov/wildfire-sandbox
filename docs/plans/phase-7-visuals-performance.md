# Phase 7 — Visuals & performance

> **Status: part 1 LANDED (2026-09-05); part 2 is a written plan.** Part 1 is the
> "make it fast and make it read" pass: a 3–4× faster sim step, a cached and
> tightened renderer, smoke plumes, contour lines, a rounder fire glow, crisp
> screen-resolution unit markers and cursors, a HUD legend and a perf readout,
> plus a bundled profiler. Part 2 (below) lists the follow-on items in enough
> detail that a smaller model can execute them one at a time, each with its own
> verification step.

Everything in this phase is **read-only over the sim** (Phase-5 plan decision
#1) or **byte-identical / documented-approximate on the sim side**. No new
physics. The science model card (`docs/science.md`) gains one line: smoke is a
visual cue, not a dispersion model.

---

## Part 1 — what landed

### Measuring first: `npm run profile`

`tools/profile.ts` runs a preset through the real pipeline and prints ms/step
per system and ms/frame per view for the shared `renderRGBA`. It is bundled
with **esbuild and run under plain `node`** on purpose: `vite-node` (what `npm
run frame` uses) rewrites every imported binding into a property access on a
module-namespace object, which V8 cannot optimise inside a hot loop — the same
code read 5–10× slower than in the browser or the Vite production build, and
`computeStats` (a 65k-cell loop) showed 5 ms where it really costs 0.5 ms.
**Never profile through vite-node or vitest; use `npm run profile`.**

Baseline (256², this machine, before this phase): sim ≈ 3.6 ms/step on every
preset; render ≈ 3.3–3.5 ms/frame on every view.

### Sim side (commit "perf: 3-4x faster sim step")

| System | before | after | how |
|---|---|---|---|
| `RothermelFireModel` | 1.1–2.4 ms | 0.4–0.9 ms | Prepared surface beds cached per (fuel id, moisture byte); the FM10 crown-proxy bed per moisture byte; the WAF per (fuel id, canopy byte). Pure functions of their keys ⇒ **byte-identical** spread. The model used to rebuild all three for every front cell every tick. |
| `FuelMoistureSystem` | 0.5–1.0 ms | 0.05 ms | **Time-sliced** on ticks shorter than 8 s: the map is split into K = ⌈8/dt⌉ row bands and each tick integrates one band over K·dt. Exponential relaxation toward a constant target composes exactly, so each cell follows the same curve sampled every K ticks. Ticks ≥ 8 s (every headless test) integrate the whole map as before. Not byte-identical at dt = 1 (a cell's byte updates on a different tick); +2–3 % burned area in `timber-crown-run`, accepted and documented in the class header. |
| `DynamicWeatherProvider` | 0.35–0.8 ms | 0.07 ms | The gust field is **held for `refreshSeconds` (default 4)** between rewrites; it drifts at 1/300 lattice/s and the mean wind ramps over hundreds of seconds, so a 4 s hold is invisible. Still a pure function of `clock.time`. |
| `RetardantSystem` | 0.2–0.4 ms | 0.08 ms | Untreated cells rejected on two loads before the rounding compare. |
| **Total** | **≈ 3.6 ms** | **≈ 0.8–1.3 ms** | |

Determinism: the CA golden is untouched (it uses neither system); every
Rothermel-path determinism test still passes (the changes are pure functions of
tick count / clock time).

### Render side (commit "feat: smoke, contours, crisp overlays …")

- **Per-world render cache** (`palette.ts`, `WeakMap<WorldState, TerrainCache>`):
  hillshade × texture jitter × contour is static until elevation is painted, so
  it is computed once. `invalidateTerrainShading(world)` marks it stale; the
  editor's new `onPaint` callback calls it (via `CanvasRenderer.invalidateTerrain`)
  after an elevation or fuel stroke. The cache also owns the per-frame scratch
  (smoke accumulators, scar-edge list) so the frame loop allocates nothing.
  `renderRGBA`'s signature is unchanged; the PNG exporter gets it for free.
- **Hot path tightened:** the unburned-terrain colour (nearly every cell, every
  frame) is inlined in `renderRGBA` over hoisted typed arrays; fuel colours live
  in flat `Float32Array`s indexed by fuel id (a `Record` probe per cell was a
  dictionary lookup); bytes are truncated with `| 0` before the typed-array
  store. Data views 3.3 → 2.0–3.0 ms/frame; terrain view without smoke ≈ 2 ms.
- **Contour lines** every 50 m (`CONTOUR_INTERVAL_M`), one cell wide (band change
  vs the west / north neighbour), hidden under water, baked into the shading
  cache ⇒ free at frame time. Terrain and elevation views read as a topo map.
- **Smoke plumes** (terrain view only; `RenderOptions.smoke`, HUD toggle):
  stateless, a pure function of the frame's world state, so the headless PNG
  shows the same plume the browser does. Each *flaming* cell lays a plume along
  the wind vector sampled at the source (length 3 + 1.4 × wind m/s cells, capped
  at 28; thicker and darker with recorded intensity and crown state, ×1.6 longer
  for an active crown), and each *smouldering scar-edge* cell (the honest main
  source — flames last seconds, edges smoulder for minutes) lays a paler, shorter
  one (every other edge cell by its static hash at 1.6× strength, half the cost).
  Puffs travel downwind and the axis meanders, both clock-driven and hash-phased.
  Composite: optical depth → α = 1 − e^−τ capped at 0.7, colour lerped
  off-white → soot grey by soot fraction; drawn **before** the glow so flames
  punch through. Cost: ≈ 0 with no fire, ≈ 2.5–3 ms on a very large fire
  (part 2 item A addresses this).
- **Rounder glow:** the 5×5 bloom uses a radial falloff table instead of
  Chebyshev rings.
- **Crisp overlays** (`overlay.ts`, the screen-resolution canvas): unit glyphs
  (crew ● / engine ■ with a tank bar / tanker ▲ pointing along its heading) with
  halo + label, dashed lead lines, the crew's queued line as dots with the head
  order ringed, the tanker's drop footprint outlined; the **cursor** shows the
  footprint of whatever a click will do (brush disc for the editor, the armed
  order's square for the command shell). `SuppressionCommand.render(ctx, vp)` now
  draws here instead of onto the 256-px view canvas. Overlay cleared every frame.
- **HUD:** a **legend** per view drawn from the palette's exported ramp
  functions (`heatRamp`, `moistureRamp`, `elevationRamp`, `canopyRamp`) so it
  cannot drift; swatches for terrain and fuel; a **Smoke** toggle; a 600× speed;
  a **perf readout** (sim ms/step · steps/frame · frame ms, EMA-smoothed in
  `main.ts`). The editor readout also reports a touched cell's recorded
  intensity and crown state.
- **Page:** the stage leaves room for the fixed HUD strip on laptop heights.
- **Tests:** `tests/render.test.ts` pins that every view renders opaque, a frame is
  a pure function of world state and never consumes `world.rng`, burning cells
  read hot, smoke is terrain-only and does change the frame, and the shading cache
  is stale until invalidated then rebuilds.

Verified: 206/206 tests, typecheck clean, `npm run frame -- timber-crown-run 1800`
and `-- grass-valley 2000` show plumes streaming downwind of the front over a
contoured landscape; browser-checked in Chrome (markers, cursor, legend, perf
readout, no console errors).

---

## Part 2 — plan for the next pass (for a smaller model)

Rules for whoever executes this: one item per commit; `npm run typecheck && npm
test` green before each commit; `npm run profile -- <preset> <steps>` before
and after any performance item and put both numbers in the commit message;
`npm run frame -- <preset> <steps> [view]` after any visual item and *look at
frame.png* (a `zoom` helper is trivial — crop + nearest-neighbour upscale — if
256 px is too small to judge). Do not touch `src/sim/**` in a visual item. Read
`CLAUDE.md` invariants first; the renderer never writes world state and never
calls `world.rng`.

### A. Smoke at constant cost (perf, renderer) — *do first*
**Problem.** `renderRGBA` lays every plume from scratch every frame; on a large
fire (≈ 300 flaming + a 7 000-cell scar) that is ≈ 3 ms/frame on top of the base
pass.
**Change.** Make the smoke accumulators *persistent* in `TerrainCache` and
amortise: each frame (1) multiply `smoke`/`soot` by a decay `0.85`, (2) lay
plumes only for sources whose static hash `noise[i]` falls in this frame's
quarter (`(frameCounter & 3) / 4 ≤ noise[i] < (frameCounter & 3 + 1) / 4`) at 4×
strength, (3) composite as today. Keep a `frameCounter` in the cache (increment
per `renderRGBA` call with smoke on). The headless PNG renders one frame, so it
must still look right: when `cache.frameCounter === 0` lay **all** sources at 1×
(cold start), then switch to the quarter schedule.
**Verify.** `npm run profile -- timber-crown-run 1800`: terrain view within
0.8 ms of the fuel view. `tests/render.test.ts` still green (the pure-function
test renders one frame from a fresh world twice — both are cold starts, so they
stay byte-identical; if you add a second render in that test, expect a
difference and assert it, do not delete the test). Browser: smoke should look
the same, slightly smoother.

### B. Ground colour cache (perf, renderer)
**Problem.** The unburned-ground colour (fuel × moisture × shade) is recomputed
for ~60 000 cells every frame though moisture changes by a byte every few
seconds.
**Change.** Add `ground: Uint8ClampedArray(n*4)` and `groundDirty: Uint8Array(n)`
to `TerrainCache` (terrain view only). Each frame: (1) refresh one of 8 row
bands (`frameCounter % 8`) plus any cell whose moisture byte differs from a
stored `moistSeen: Uint8Array` copy — compare in the band loop; (2) `rgba.set(
ground)` as the starting frame (one memcpy); (3) then only overwrite Burning,
Burned, water (shimmer) and retardant cells with `cellRGB`. `invalidateTerrainShading`
must also flag every ground cell dirty. Water shimmer and retardant still animate
because they are drawn in step 3. Editor paint of fuel/moisture: `onPaint` already
calls `invalidateTerrain` for fuel; add moisture/canopy to that call in `main.ts`.
**Verify.** profile: terrain view (smoke off — pass `smoke:false` from a
temporary flag or read the fuel view as a proxy) drops from ≈ 2 ms to < 1 ms.
`tests/render.test.ts`: keep the pure-function test green (a fresh world is a
full refresh on the first frame — implement "first frame refreshes everything").
Add a test: paint a moisture byte, render, the pixel changes within 8 frames.

### C. Explicit front list in the fire model (perf, sim, byte-identical)
**Problem.** `markCandidates` and the main sweep are three O(n) passes per tick;
at 512² they dominate.
**Change.** In `RothermelFireModel.step`, after the dilation, build a compact
`Int32Array` of candidate indices once (`cand[i] !== 0 && fire[i] !== Burned`)
and loop over it instead of `for y, for x` — same row-major order (build it in
index order), so results are **byte-identical**. Then replace the full dilation
with an incremental one: keep `ignited` from the previous tick, and only dilate
around cells that *changed* state this tick (`next[i] !== fire[i]` from the last
step, stored in a small list). Do the compaction first (safe, simple), measure,
then the incremental dilation as a second commit.
**Verify.** `tests/determinism.test.ts`, `tests/spread-ros.test.ts`,
`tests/crownFire.test.ts` all green (they pin byte-identical results). Add to
`tests/render.test.ts`'s neighbour `tests/scenario.test.ts`: a 3000-step
`timber-crown-run` fire layer hash before/after must match — capture the hash
once with the old code and hard-code it. profile at 512²: add a `--size 512`
override to `tools/profile.ts` (`{...preset, width, height, ignitions:'center'}`).

### D. Larger maps from the URL (feature, browser only)
**Change.** `main.ts`: read `?size=384|512` and load `{...preset, width, height}`
(ignition points in presets are authored for 256 — when `size` is given, scale
`ignitions` and `agents` cell coordinates by `size/256`; write a tiny helper
`scaleScenario(s, size)` in `src/scenario/scenario.ts` with a unit test). Show
the size in the Scenario panel description line. Keep 256 the default.
**Verify.** `?size=512&scenario=grass-valley` runs at ≥ 30 fps at 120× after
items A–C; the perf readout tells you.

### E. Animated wind streamlines (visual, overlay canvas only)
**Change.** In `overlay.ts` add `WindParticles`: 600 particles in cell space,
each advected by the wind at its cell each frame (`p += wind * 0.02 cells`), with
a 40-frame life, respawned at a hash-derived position, drawn as short fading
polylines. Toggle replaces (or accompanies) the arrows via the same HUD button
(cycle: off → arrows → streamlines). Browser-only, not in the PNG, may use its own
`Math.random`-free counter (use the existing `hash01` pattern; never `world.rng`).
**Verify.** Visually; wind shift in `shifting-winds` should visibly swing the
streamlines over the 30 sim-minutes.

### F. Spot-fire flash (visual, palette)
**Change.** In `cellRGB`'s Burning branch: if `burnElapsed < 12 s` **and** none
of the 8 neighbours is Burned (i.e. this is an isolated new ignition — an ember
or a click, not the front arriving), draw a bright white-yellow core and add a
one-ring extra glow in the glow pass (reuse `scarEdge`-style neighbour scan;
cost only for burning cells). Makes spotting legible: you see where an ember
landed.
**Verify.** `npm run frame -- timber-crown-run 2400` shows distinct bright specks
downwind of the run; `tests/render.test.ts` "burning cells are hot" stays green.

### G. Renderer seam: WebGL2 `IRenderer` (perf, large, optional)
Only if A–C are not enough at 512²+. Upload the layers as textures (`fire`,
`fuel`, `moisture`, `crown`, `intensity`, `elevation`, `retardant`, `windU/V`)
each frame and port `cellRGB`/glow/smoke to a fragment shader. Keep
`CanvasRenderer` as the reference and the PNG exporter on `renderRGBA`; add a
`?renderer=gl` switch. Verify by diffing a GL frame read back with
`gl.readPixels` against `renderRGBA` (tolerance ±3 per channel).

### H. Odds and ends
- `tools/profile.ts`: add `--size` (see C/D) and print a "budget" line: at 60 fps
  and the preset's `timeScale`, how many ms are left.
- HUD: show `Contours` and `Smoke` toggles under View; persist toggles in the URL
  (`?smoke=0&wind=1`) so a shared link reproduces the view.
- `index.html` footer: replace the colour hints (now in the legend) with the
  three interaction hints only.
- The stray zero-byte file `=` in the repo root (from a shell redirect accident,
  untracked) should be deleted by the repo owner.
