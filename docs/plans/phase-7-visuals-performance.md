# Phase 7 — Visuals & performance

> **Status: part 1 LANDED (2026-09-05); part 2 items A-C and F LANDED
> (2026-09-05/06), D, E, G, H still planned.** Part 1 is the
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

### A. Smoke at constant cost (perf, renderer) — ✅ LANDED
Smoke accumulators are now persistent in `TerrainCache`: each frame decays the
field by 0.85 and re-lays only the quarter of the sources whose schedule hash
falls in this frame's slot; a cold start (`frameCounter === 0` — a fresh world,
or the first frame after smoke was off) lays every source at gain 1, so the
headless PNG and the browser agree.

**Two corrections to the plan as originally written — do not undo them:**
- The deposit gain is **0.6×**, not the "4×" this section first proposed. Under
  decay `d` with `K` slots, depositing `g` every `K` frames settles at a mean of
  `g / (K·(1−d))`, so `g = K·(1−d) = 0.6` is what preserves the old stateless
  field's average. 4× would have been ≈ 6.7× too thick — a saturated grey
  blanket over the whole fire.
- The schedule uses a **second hash** (`hash01(i ^ 0x5bf03635)`), not
  `cache.noise`: the scar-edge loop already gates on `noise`, so sharing it
  would confine every edge source to two of the four slots and make the smoke
  pulse. (The plan's predicate also mis-parsed: `frameCounter & 3 + 1` is
  `frameCounter & 4`.)

The decay pass zeroes cells below 0.004; otherwise the persistent field grows a
long tail of near-zero values, the composite pass's early-out stops firing and
compositing costs *more* than it did stateless.

**Result** (`npm run profile -- timber-crown-run 1800`, 256²; the profiler grew a
`terrain (no smoke)` row so the plume cost can be read directly):
`terrain 3.689 / no-smoke 1.787` → `terrain 2.558 / no-smoke 1.732`, i.e. the
plumes went from 1.90 to 0.83 ms/frame. Tests: two new ones in
`tests/render.test.ts` — a second frame differs from the first, and the total
smoke deviation after 8 frames stays within 30% of the cold-start frame (that
one pins the gain).

### B. Ground colour cache (perf, renderer) — ✅ LANDED
`TerrainCache.ground` (RGBA per cell) holds the unburned terrain colour and is
rewritten one of 8 row bands per frame; a frame starts from `rgba.set(ground)`
(one memcpy) and the loop repaints only what animates — fire, the water shimmer,
retardant — skipping nearly every cell on two byte reads. Water is a cached
static flag (`TerrainCache.water`) mirroring `terrainRGB`'s own water branch,
rather than a fuel+elevation test per cell.

No `moistSeen` compare was needed: the band cycle catches every moisture change
within 8 frames (~0.13 s) on its own. A drag-paint would show that as stripes,
so the editor's moisture stroke calls the new `invalidateGroundColours` (the
cheap sibling of `invalidateTerrainShading` — it keeps the hillshade);
elevation/fuel strokes already invalidate the shading, which now clears the
ground too. Canopy does not enter the terrain view's ground colour.

**Result** (same run): `terrain 2.558 / no-smoke 1.732` → `terrain 1.666 /
no-smoke 0.792`. The settled 40-frame terrain frame is byte-identical to the one
before the change. Test added: a moisture change shows within the 8-frame cycle,
and at once after an invalidate.

### C. Explicit front list in the fire model — ✅ LANDED (compaction only)
`collectCandidates` (was `markCandidates`) compacts the survivors of the 3×3
dilation into an `Int32Array` of indices during its vertical pass, and the sweep
iterates that list instead of walking the whole map. Byte-identical, and pinned
by a new golden in `tests/scenario.test.ts`: an FNV-1a hash over fire +
intensity + crown after a 1200-step `timber-crown-run` on the **mounted**
pipeline (the determinism test's golden pins the Phase-1 CA reference instead).
The recorded number was verified to be the one the pre-compaction model
produces. `tools/profile.ts` gained `--size=N` (square map, centre ignition).

**Result** (`fire:rothermel` ms/step, timber-crown-run 1800 steps):
256² `0.559 → 0.414` (sim total 0.918 → 0.825); 512² `1.942 → 1.068` (sim total
3.590 → 2.494).

**The incremental dilation is deliberately NOT done — do not add it.** The three
whole-map passes it would replace are only ~0.3–0.4 ms of the 1.07 ms the fire
model costs at 512², and it could not remove them all: `SpottingSystem`,
`GroundCrew` (backburn) and the editor's ignite tool all write Burning cells
straight into `layers.fire` without going through the fire model, so an
incremental scheme still needs one whole-map pass to notice them. That is
~0.2 ms saved at 512², in exchange for a mechanism that silently drops a spot
fire whenever the detection is wrong. If more sim speed is wanted,
`weather:dynamic` (0.272), `moisture:timelag-emc` (0.228) and
`suppression:retardant-field` (0.370, all at 512²) are plain whole-map sweeps of
the same size and are the cheaper targets.

### D. Larger maps from the URL (feature, browser only) — ✅ LANDED
`?size=N` (64..1024, default and identity 256) re-authors the preset through
`scaleScenario(s, size)` in `src/scenario/scenario.ts`; the Scenario panel says
how big the map is in cells and kilometres.

**The caveat this item was written with is now paid off, not accepted.** It read:
after A–C the terrain view was ready at 512² but the data views were not (fuel
10.2, moisture 11.8, canopy 10.6, intensity 9.6, elevation 16.7 ms/frame),
because item B cached the terrain ground only, and it offered "extend the cache
to the data views, or accept that `?size=512` is a terrain-view feature". The
cache was extended first — see the commit "perf: cache the unburned colour for
every view, not just terrain", which took the mounted view's unburned colour into
the same one-band-a-frame buffer. Re-measured on this machine
(`npm run profile -- timber-crown-run 1800 --size=512`), before → after:

| view | before | after |
|---|---|---|
| fuel | 12.94 | 2.80 |
| moisture | 15.49 | 3.07 |
| elevation | 13.29 | 3.53 |
| canopy | 14.93 | 3.65 |
| intensity | 12.12 | 2.90 |
| terrain | 8.26 | 6.56 |

(The before column is this machine's own baseline, higher across the board than
the numbers quoted above; compare within a column, not across.) Every view now
fits the 60 fps budget at 512² with room to spare — the profiler's new budget
line says so directly.

**Why scaling cell coordinates is the whole transform**, and the one thing to
know before authoring at another size: `generateTerrain` samples its value noise
in *normalized* coordinates (`u = x/(width-1)`, against fixed 4/8/16/32 grids),
so a seed draws the same landscape at any size. A point authored at 256 lands on
the same hillside at `size/256`, and a test pins the property directly (elevation
agrees within 20 m of a 0–1000 m range across the whole map between 256 and 512).
`cellSize` is deliberately not scaled, so a bigger map is more **ground** — 512
cells at 30 m is 15.4 km across, four times the area. The trade is that the fixed
0–1000 m relief now spans twice the distance, so **slopes come out about half as
steep**: a 512 run is a gentler landscape as well as a wider one, and a preset
authored for 256 will spread less aggressively uphill there. If that ever needs
to change, the alternative is scaling the noise grids with the map (same feature
size in cells, same slopes) at the cost of 512 being a *different* landscape from
256 — a scope call for the repo owner, not a silent fix.

### E. Animated wind streamlines (visual, overlay canvas only) — ✅ LANDED
`WindParticles` in `overlay.ts`: 600 particles in cell space, advected by the
wind at their own cell, each leaving a short fading tail, respawned at a
`hash01`-derived position (a local copy of the palette's hash — it is not
exported there, and widening that module's surface for an overlay toy would put
the byte-identical render tests in the way of a visual tweak). The HUD's one wind
button now cycles off → arrows → streamlines and **relabels** as it goes; an `on`
class alone would make the two modes look identical.

**Three decisions worth keeping:**
- **`update` is split from `draw`,** and `update` never touches a canvas. That is
  what lets `tests/windParticles.test.ts` pin the advection headlessly — nothing
  else in `overlay.ts` is tested, because everything else mixes state and `ctx`.
  The class doc says outright that it is the one stateful thing in a file whose
  header promises pure reads; a streamline is only meaningful because it
  remembers where it has been.
- **Real seconds, never `dt × timeScale`.** At 600× a particle would cross the
  map in a single frame. The streamlines therefore show the field's *direction
  and relative strength* at a legible speed at every run speed — they are not a
  scale model of the air's speed, and they keep drifting while paused. Advection
  runs in fixed 1/60 s sub-steps capped at 8 per call, so the frame loop's
  clamped 0.25 s jump can't shred a trail either.
- **Respawn happens *before* the wind is sampled.** Reading `windU` past the end
  of the typed array yields `undefined`; the position becomes NaN and stays NaN
  for the rest of the run — invisible, silent, permanent. The bounds check is
  the whole defence.

**Tuned once against a real frame, as expected.** The plan's gain with an
every-3rd-tick, 8-sample history gives 0.4 s of tail — at a 5 m/s breeze that is
a 2.9-cell dash that reads as a dot, not a streak. Tail length is
`TRAIL × SAMPLE_TICKS` of *time*, not of memory, so it went to 10 samples every
6 ticks = 1.0 s ≈ 6 cells at 5 m/s, ~14 at a gale. Segments are bucketed into 5
alpha levels and stroked one path per bucket — 600 separate `stroke` calls a
frame would show up in the HUD's own perf readout.

**Verified — geometry only.** `npm run frame` is useless here (the overlay is not
in the PNG), so a scratch script drove the real `update`/`draw` against a
recording context and rasterised the segments over a real terrain frame: at 5
sim-minutes of `shifting-winds` the streaks run SW→NE, at 20 minutes they have
swung to nearly N→S — the swing the plan asked to see. Tests: particles advect
downwind at the documented gain, stay finite and on the grid when blown hard off
an edge for 20 s, reproduce exactly between two instances, and never draw on
`world.rng`.

**The animation itself is NOT verified** — two frozen frames prove direction and
tail length and cannot show motion, and the browser was unreachable when this
landed. So the one parameter tuned against a still image (the 1.0 s tail) is the
one a still image cannot settle: whether the tails read as motion rather than as
drifting dashes wants a look at `?scenario=shifting-winds` in `npm run dev`. If
they read wrong, `TRAIL`/`SAMPLE_TICKS` is the knob. **Do not scale the gain by
`timeScale` to "match" the smoke** — `depositPlume` anchors a fixed-length shape
at the source and only its internal texture moves (at ~30 Hz at 120×, read as
shimmer), so there is no legible downwind transport for the streamlines to
disagree with.

### F. Spot-fire flash (visual, palette) — ✅ LANDED
A fresh isolated ignition — an ember landing, a click, a backburn going in —
gets an additive white core plus a wider (radius-3) halo, fading linearly over
`SPOT_FLASH_SECONDS = 12`, so you see *where* spotting started a new fire
instead of only meeting the fire it grows into. Toggleable: `RenderOptions.spotFlash`
(default true), a **Spot flash** HUD button beside Smoke, and a 5th positional
`spots` argument on `npm run frame` (`... terrain 0`). Off is the honest
ground-observer reading — only the resulting fire, never the moment it started —
which is why it is a toggle and not a constant.

**Three corrections to the plan as originally written — do not undo them:**
- **The neighbour rule needs both halves.** "No 8-neighbour is Burned" alone is
  *wrong for fast fuels*: an Albini flame residence time is τ = 384/σ ≈ 6.6 s in
  grass, so the cell behind the leading edge is still `Burning`, not yet
  `Burned`, and **the whole front would flash**. `isSpotFlash` also rejects any
  `Burning` neighbour with a larger `burnElapsed` — "nothing next to me ignited
  before I did". Ties flash (a backburn lit along a line on one tick reads as
  the whole line catching, which is what happens).
- **Not gated to the terrain view.** Smoke is terrain-only; fire is drawn
  identically on every view by design (see the `palette.ts` header), so the
  flash is gated on the option alone.
- **Additive, not an overwrite,** and with its own blue term. Two flashes can
  overlap, and it has to compose with the crown boost, so a `set` on the cell
  would be order-dependent; and the glow adds no blue (`GLOW_R/GLOW_G` only), so
  without `FLASH_CORE_B` "white-hot" would read as plain yellow.

It lives inside the existing glow sweep — no new whole-map pass. In grass the
age gate prunes nothing (every flame is under 12 s), so the neighbour scan runs
over the flaming front: O(front · 8) with a first-disqualifying-neighbour early
exit, the same order as the `scarEdge` pass already run each frame.

**Duration is speed-dependent and cannot be fixed here.** 12 sim-seconds is
~6 rendered frames at the default 120× and ~1 frame at 600×; the window cannot
be widened, because residence time ends the `Burning` state first and
`burnElapsed` freezes at burnout. Extending into `Burned` would need a new
timestamp layer — not worth it. The HUD tooltip says so.

**Verified.** `npm run frame -- timber-crown-run 1685 terrain 1` vs `... 0`
differ in 734 px / 16 flash cores; a 14-frame headless strip from step 852 shows
the core fading monotonically (blue delta 138 → 12 over the window) while an
older established spot nearby stays dim orange in both. Tests: an ordinary front
renders **byte-identical** with the flash on and off (that is what pins "no
leakage into the normal front"), one isolated fresh ignition differs and agrees
again at t = 12 s, and the flash shows on every view.

### G. Renderer seam: WebGL2 `IRenderer` (perf, large, optional) — NOT NEEDED YET
After A–C and the per-view colour cache, the dearest view at 512² is terrain at
6.6 ms/frame inside a 12.4 ms render budget, so nothing is asking for this. It
stays written down for 1024²+ or for whatever a future view costs.
Only if A–C are not enough at 512²+. Upload the layers as textures (`fire`,
`fuel`, `moisture`, `crown`, `intensity`, `elevation`, `retardant`, `windU/V`)
each frame and port `cellRGB`/glow/smoke to a fragment shader. Keep
`CanvasRenderer` as the reference and the PNG exporter on `renderRGBA`; add a
`?renderer=gl` switch. Verify by diffing a GL frame read back with
`gl.readPixels` against `renderRGBA` (tolerance ±3 per channel).

### H. Odds and ends — ✅ LANDED (except the stray file, which is the owner's)
- `tools/profile.ts`: `--size` was already there; it now also prints a **budget**
  line. The browser paces by wall clock, so a preset at `timeScale` sim-seconds
  per real second owes `timeScale/60` steps in every 16.67 ms frame — the sim's
  share is set by the speed the scenario asks for, not by the step cost alone.
  The line prints what that leaves and each view is marked `ok` / `OVER by x` against it.
- HUD: `Smoke` was already a toggle; `Contours` is new. It could not simply
  rebuild the shading (that recomputes hillshade over the whole map on a click),
  so `TerrainCache` keeps a **second** lighting array with the contour factor left
  out and the frame loop picks one of the two once per frame — no per-cell branch.
  Two arrays rather than a mask is also what keeps "contours on" bit-identical:
  `Float32Array` stores round, so darkening a stored shade at use time is a
  different number from darkening it before the store, and every contour cell
  could shift a byte. A toggle is a cold start for the colour cache, like a view switch.
- View state persists in the URL: `?view=`, `?wind=`, `?smoke=0`, `?flash=0`,
  `?contours=0` (defaults deleted, not written, so a plain URL stays plain), and a
  scenario switch carries them and `?size=` across its reload. `replaceState`,
  never `assign` — a reload would rebuild the world and restart the fire. The HUD
  takes a starting state and reports changes; `main.ts` is the only thing that
  touches the address bar.
- `index.html` footer: down to the three interaction hints.
- The stray zero-byte file `=` in the repo root (from a shell redirect accident,
  untracked) should be deleted by the repo owner.

**How the render work was verified.** The per-view cache and the contours toggle
are pure-performance refactors that must be pixel-identical, and nothing in
`tests/` asserts render output. Both were checked with a throwaway byte-diff
(kept out of the repo, under `M:\claud_projects\temp\outdoorfire-item-d\`): a
copy of `palette.ts` from before this pass is dropped into `src/render/` as a
second module, and every preset is rendered through both — 4 presets × 256/384 ×
all 6 views × two passes (so the view-switch path runs) × smoke on/off × 12 *warm*
frames, i.e. long enough that every one of the 8 row bands has been rewritten.
2304 frame comparisons, 0 mismatches, run once after each change. Do the same for
any future change to the cached composition; the profiler tells you it got
faster and nothing tells you it is still right.
