# Phase 11 — the smooth wavefront (Huygens marker points)

> **Status: Stages 0 and 1 SHIPPED.** `spreadEngine: 'huygens'` runs a marker
> front end to end — Richards' equations, substepping, density control, barriers,
> seeding, rasterisation — and §7's table is measured below. `'raster'` remains
> the default, so nothing in [`docs/science.md`](../science.md) has moved.
> **Stage 2** (perimeter merging) and **Stage 3** (crossover removal, then the
> call on the default) are still to do; §D8's burnable enclaves stay out of scope
> for the phase.

**Goal:** stop carrying the fire as a raster of finitely many rays. Carry it as a
**polygon of marker points** that each advance by Richards' (1990) elliptical
growth equations, the way FARSITE does, and rasterize the result into the same
`fire` / `intensity` / `crown` layers everything downstream already reads.

---

## 1. Why — what the raster cannot do, restated

Phases 8 and 8b got the *directional law* right (§1a: one wind–slope vector sum
per cell, every other direction read off the Anderson spread ellipse) and then
got the *propagation* as right as a raster gets (§1b: 16 rays, one arrival
accumulator each, a shortest path over the ray graph). What is left is not a
modelling error, it is a **discretisation floor**:

- **Windless:** a rounded 16-gon inscribed in the true circle —
  1.000 / 0.940 / 0.960 / 0.960 / 0.920 of the due-east radius at
  0 / 11.25 / 22.5 / 33.75 / 45°, about **1.087 max/min**. Every direction is at
  or inside the truth; what remains is per-tick quantisation (a cell fires on the
  tick its accumulator passes 1, so a ray whose crossing time is not a whole
  number of ticks always fires late).
- **Windy:** measured length-to-breadth error against Anderson
  **+4 / +3 / +7 / +8 / +12 / +4 / +28 %** at 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 m/s.
  The head is a ray and is exact; the backing rate is within a few percent; the
  error is **flank width**, and it *understates* burned area.

§9 already records the exit: *"A 32-ray template would keep shrinking the polygon
defect at 4 floats per cell per added ray … the honest next step is instead
FARSITE-style Huygens expansion — marker points on the perimeter rather than a
raster — which is a later fire model behind the same seam (handoff §4.2), not a
wider stencil."* This phase is that step.

Three things the raster cannot give at any ray count, and which fall out of a
marker front for free:

1. **Sub-cell arrival.** A marker sits at a real-valued position; the front
   crosses a cell boundary at a real time, not on a tick edge. The windless
   1.087 anisotropy is mostly this.
2. **Direction continuity.** 16 rays quantise the direction of travel to 16
   values per step. A marker moves along the ellipse normal in whatever direction
   the geometry actually points.
3. **Memory that does not scale with the map.** The 16 `Float32` accumulators per
   cell are 4 MB at 256², 17 MB at 512² and **67 MB at `?size=1024`**. A marker
   front costs O(perimeter points), which is a few thousand floats regardless of
   map size.

---

## 2. The source — and the warning that comes with it

**`firelab/behave` does not cover this phase.** Everything transcribed in
Phases 2, 6, 8, 9, 10 and the spotting work came out of BehavePlus, which is a
*point* model library: `surfaceFire`, `fireSize`, `spot`, `crown`. It has no
propagation at all — it answers "how fast, how hot, how far" for one fuel bed and
stops. Nothing in it says how a perimeter moves.

The propagation maths is **Richards (1990)**, *An elliptical growth model of
forest fire fronts and its numerical solution*, Int. J. Numer. Methods Eng.
30:1163–1179, as used by **Finney's FARSITE** (RMRS-RP-4). The Forest Service
copy of RMRS-RP-4 is a **scanned-image PDF** whose equations are not
machine-extractable, and the Richards paper is paywalled — so per the
`rothermel-reference-sources` rule (published coefficients never come from
recall) the transcription below is taken from the **FARSITE C++ source**, which
stands in the same relation to Richards as BehavePlus does to Rothermel: the
reference implementation, not a remembered formula.

- Source: `edigley/farsite` (a mirror of the FARSITE 4 C++), files
  `fsxwmech.cpp` (the growth maths), `newclip.cpp` (perimeter surgery),
  `fsxwrast.cpp` (polygon → raster), `fsxpfront.cpp` (ring merging).
- Working copy for this phase: `M:\claud_projects\temp\farsite-src\`.
- Anything below that is *not* in that source is marked as ours.

### 2a. Richards' equation, verbatim

`Mechanix::grow(double ivecdir)` — `fsxwmech.cpp:588`:

```cpp
f2 = pow2(flank);
h2 = pow2(head);
part1 = f2 * cos(ivecdir) * (xdiff * sin(ivecdir) + ydiff * cos(ivecdir));
part2 = h2 * sin(ivecdir) * (xdiff * cos(ivecdir) - ydiff * sin(ivecdir));
part3 = h2 * pow2((xdiff * cos(ivecdir) - ydiff * sin(ivecdir)));
part4 = f2 * pow2((xdiff * sin(ivecdir) + ydiff * cos(ivecdir)));
part5 = f2 * sin(ivecdir) * (xdiff * sin(ivecdir) + ydiff * cos(ivecdir));
part6 = h2 * cos(ivecdir) * (xdiff * cos(ivecdir) - ydiff * sin(ivecdir));
xt = ((part1 - part2) / sqrt((part3 + part4))) + back * sin(ivecdir);
yt = ((-part5 - part6) / sqrt((part3 + part4))) + back * cos(ivecdir);
```

`(xdiff, ydiff)` is the **central difference along the perimeter** — the previous
vertex minus the next one (`fsxwmech.cpp:168`), i.e. a discrete `(x_s, y_s)`, the
tangent. `ivecdir` is the azimuth of the direction of maximum spread. `(xt, yt)`
is the vertex velocity, integrated forward to move the point.

### 2b. The ellipse dimensions, verbatim

`Mechanix::ellipse(double iros, double wspeed)` — `fsxwmech.cpp:1370`, with
`Mechanix::headback()` at `:1362`:

```cpp
lb_ratio = .936 * exp(.1147 * wspeed) + .461 * exp(-.0692 * wspeed) - .397;
if (lb_ratio > 8.0) lb_ratio = 8.0;           // maximum eccentricity
// headback(): Alexander's head/backing ratio, fire origin at the focus, eq [16]
part     = sqrt(pow2(lb_ratio) - 1);
hb_ratio = (lb_ratio + part) / (lb_ratio - part);

head  = iros;
back  = head / hb_ratio;                       // Alexander 1985
flank = ((head + back) / lb_ratio) / 2.0;
head  = (head + back) / 2.0;                   // -> a, the semi-major axis
back  = head - back;                           // -> c, the focus offset
```

**This is already in the repo.** `lb_ratio` is character-for-character
`lengthToBreadthRatio` in [`src/sim/fireEllipse.ts`](../../src/sim/fireEllipse.ts),
cap 8 included. And `hb_ratio` is our backing rate in disguise: with
`E = √(LB² − 1)/LB`,

```
1/HB = (LB − √(LB² − 1)) / (LB + √(LB² − 1)) = (1 − E)/(1 + E)
```

which is exactly `backingRate(headRate, ecc)`. So **the directional law FARSITE
propagates with is the one this repo already ships**, established by identity
rather than by hoping two sources agree. Phase 11 changes *only how the front is
carried*. That is the single most important scoping fact in this document.

### 2c. Rewritten without azimuths (ours)

FARSITE works in compass azimuth (`x = sin θ`, `y = cos θ`); this repo carries the
head direction as a unit vector `(headUx, headUy)` in world coordinates and has no
aspect bookkeeping anywhere (Phase 8, `windSlopeResultant`). Substituting
`u = sin θ`, `v = cos θ` and writing the two projections of the tangent

```
p = x_s·u + y_s·v          (tangent component along the head)
q = x_s·v − y_s·u          (tangent component across it)
D = √(h²·q² + f²·p²)
```

gives the same algebra with no trig calls at all:

```
xt = ( f²·v·p − h²·u·q) / D + c·u
yt = (−f²·u·p − h²·v·q) / D + c·v
```

**`h`, `f` and `c` are ellipse *dimensions*, not rates.** They are the values
`ellipse()` leaves in its members *after* the reassignment in §2b, which is easy
to miss because they reuse the names `head`/`flank`/`back`. With `R` the
Rothermel head rate and `B = R/HB` the backing rate:

```
h = (R + B)/2          semi-major a
f = (R + B)/(2·LB)     semi-minor b
c = (R − B)/2          focus offset
```

Plugging the raw Rothermel head rate in as `h` produces something that still
looks like a fire, which is why this is spelled out rather than left implied.

#### The handedness and winding trap

FARSITE's `(x = sin θ, y = cos θ)` is **compass azimuth: x east, y north.** This
repo's raster is row-major with `y = (i/width)|0`, and `src/render/overlay.ts:414`
takes `hy = -1` as north — so **repo `+y` is south**, the opposite sense. The
substitution above is self-consistent *provided* the tangent `(x_s, y_s)` and the
head vector `(u, v)` are both expressed in the repo frame, but `q = x_s·v − y_s·u`
is a cross product: **its sign flips under that reflection**, and so does the
question of which side of the tangent is "outward". That sign is cancelled — or
doubled — by the perimeter's **winding order**, which FARSITE fixes by taking
`xdiff = xptl − xptn` (previous minus next, `fsxwmech.cpp:168`) and tracks
explicitly as an inward/outward flag (`GetInout(CurrentFire) == 2`, in the same
block quoted for the 1.4 divisor in D7).

So handedness and winding must be pinned **together**. Phase 11 fixes the
convention as: **vertices stored counter-clockwise in screen coordinates (x
right, y down)**, tangent taken as `previous − next`.

**That is now settled by derivation rather than by trying both signs**, which is
the better answer and was found before any code was written. Rewritten in basis
form the velocity is `V = −(h²q/D)·ĥ + (f²p/D)·ĝ + c·ĥ`, where `ĥ = (u, v)` is the
head direction and `ĝ = (v, −u)`. It depends on the frame only through how `ĝ` and
the winding relate, so the formulas apply **verbatim** in screen coordinates under
the winding above — and the four cases fall out analytically: the head marker
moves at `a + c = R` along `ĥ` (the Rothermel head rate exactly), the back marker
at `c − a = −B` (the backing rate), the widest marker at `b` across the head plus
a drift `c` along it, and at `E = 0` every marker moves outward at `R`. That
drift term is the one easy to drop, and it is what makes the envelope an ellipse
about its *focus* rather than about its centre.

The two gates below still run, as confirmation rather than as discovery, and
neither is optional:

- **Expansion test.** A seed ring under zero wind must grow in area, not shrink.
  Catches the sign outright.
- **Oblique-wind axis test.** With wind ~30° off-axis, the measured long axis of
  the burn must match `headUx/headUy` from `windSlopeResultant` to within a degree
  or two. This is the one that matters: **a mirrored ellipse has identical
  anisotropy, identical LB at every wind speed and the same 11.25° radius**, so
  every number in §7 passes while the fire runs off in the wrong direction. The
  LB series cannot discriminate; only an off-axis direction check can.

Zero `sin`/`cos`/`atan2` per vertex per substep — which matters, because this runs
per marker per substep rather than per cell per tick.

---

## 3. The contract — geometry inside, rasters outside

**The perimeter is fire-model-internal state. The layers do not change.** This is
what makes Phase 11 a swap behind `IFireModel.step` instead of a re-plumb of
every system. The precedent is already in `RothermelFireModel`: `progress`,
`next`, `bedCache`, `wafCache` and the candidate list are all model-private
derived state that no other system knows exists.

A polygon list must **not** go into `Layers`. `Layers` is typed arrays (world.ts:
"Systems communicate ONLY through these"), and putting geometry there would force
the renderer, spotting, stats and suppression to learn about vertices.

| Consumer | Reads today | Reads after Phase 11 |
|---|---|---|
| Spotting (`spottingSystem`) | `fire`, `intensity`, `crown`, `canopy` | unchanged |
| Crown / ember thresholds | `intensity` at ignition | unchanged (see §5c) |
| Suppression (crew / engine / retardant) | writes `fuel`, `moisture`, `retardant` | unchanged |
| Renderer (`palette`, `overlay`) | `fire`, `intensity`, `crown`, `burnElapsed` | unchanged |
| Stats HUD | `fire`, `intensity` | unchanged |
| Determinism golden | the CA path | untouched — a different model |

Each tick the Huygens model: advances markers in continuous space → resolves the
perimeter → rasterises → sets `fire`, and writes `intensity` / `crown` /
`burnElapsed` on the cells that flipped, in exactly the place
`RothermelFireModel` writes them today.

---

## 4. Decisions

### D1 — A new fire model class, not a flag inside the old one

`src/sim/huygensFireModel.ts`, implementing `IFireModel`, selected by a new
scenario field `spreadEngine: 'raster' | 'huygens'` with **`'raster'` the
default**. Two fire models already coexist (`CaFireModel`, `RothermelFireModel`);
this is the third, and the seam was built for it (handoff §3.3). The default
stays raster until §7's measurements justify flipping it, and `'raster'` keeps
every measured number in `docs/science.md` reproducible — the same escape-hatch
discipline as `spreadTemplate: 'ring8'` and `spreadShape: 'perDirection'`.

### D2 — Stage 0 is a byte-identical refactor: extract the cell behaviour

The Huygens model needs everything `RothermelFireModel` knows about a *cell* —
the bed cache, the wind adjustment factor, the crown bed, `prepareCellEllipse`,
`ellipticalDirection`, the recorded intensity and crown type — and none of what
it knows about *rays*. Copying that is how two models drift apart.

Extract it into `src/sim/surfaceBehaviour.ts`: given `(world, cellIndex)`, return
head rate, head direction, eccentricity, intensity and crown type. Pure
refactor — **no behaviour change** — gated on the `timber-crown-run` golden and
the whole suite being byte-identical before a line of Huygens code is written.

**The same stage splits the options type.** `spreadShape` and `spreadTemplate`
are raster-only knobs, but they live in `RothermelFireModelOptions`, which
`Scenario.fireModel` is typed off (`src/scenario/scenario.ts:80`). The Huygens
model wants the *shared* knobs — `windReference`, `canopy`, the moisture fields,
`dynamicHerbLoad` — and neither of those two. Split the type into shared and
raster-only halves here, under the same byte-identical gate; left to Stage 1 it
lands as unplanned type churn in the middle of the interesting work.

### D3 — Reuse `fireEllipse.ts` unmodified; add only the vector-form Richards step

Per §2b the ellipse maths is already the same maths. A new pure module
`src/sim/richards.ts` holds §2c and nothing else, testable against the analytic
ellipse with no world state — the same shape as `spotDistance.ts` and
`fireEllipse.ts`.

### D4 — Substepping is the containment mechanism, and it is FARSITE's own

**The hazard:** a marker advancing `R·dt` can step clean over a 30 m nonburnable
line in one tick. `tests/suppression.test.ts` pins that a one-cell cut holds and
that a one-cell gap in it leaks. This is the direct descendant of the Phase-8b
supercover gate, where the ungated version leaked **299 cells**; assume the same
magnitude here until measured.

FARSITE already answers this, and the answer is structural rather than a
bolt-on. `Mechanix::limgrow()` (`fsxwmech.cpp:617`) caps each advance at the
*distance resolution* and decrements the remaining time:

```cpp
MINDIST = GetDynamicDistRes() * MetricResolutionConvert();
if (dist > MINDIST) {
    fdist = MINDIST / dist;
    xpt = midx - distx * fdist;                 // clamp to MINDIST along the spread direction
    timerem = step - (MINDIST / (dist / step)); // remainder of the timestep
}
else timerem = 0.0;
```

Ours: **cap the per-substep advance at `cellSize/2`** and loop until the tick is
spent. A marker then cannot cross a one-cell barrier without landing *inside* it
at some substep, where a fuel test stops it. Two guards, both cheap:

1. A marker whose new position lands in nonburnable fuel does not move this
   substep. (FARSITE does this in `fsxwbar.cpp` with explicit barrier polygons; a
   fuel-layer test is the same thing on our data model.)
2. **Rasterisation never ignites a nonburnable cell** — independently true today,
   and it means a polygon bulging over a rock island still leaves the island
   unburned.

Acceptance is `tests/suppression.test.ts` unchanged and passing on the Huygens
path, both halves: the line holds, and the one-cell gap leaks.

### D5 — External ignitions seed new perimeters

The ignition tool, spotting embers and backburns all write `fire` directly. Each
tick the model scans for `Burning` cells that no perimeter accounts for and seeds
a small ring (a regular n-gon of radius ≈ half a cell) at the cell centre. The
hook and the precedent already exist — `src/sim/rothermelFireModel.ts:1024` does
exactly this reasoning for `intensity[i] === 0` on an externally-lit cell.

### D6 — Merging is in scope, and it is not optional

With intensity-driven spotting mounted (§6) the shipped presets throw brands
300–1300 m, so `timber-crown-run` carries **multiple concurrent perimeters from
the first ember**, and they merge once they have grown together — minutes to
tens of minutes, not immediately. Either way a Huygens front that cannot merge is
not usable on the presets that already exist. FARSITE's machinery:
`Intersections::FindFirePerimeter` / `FindOuterFirePerimeter` and
`StandardizePolygon::Cross` in `newclip.cpp`, `PostFrontal::MergeFireRings` in
`fsxpfront.cpp`.

### D7 — Perimeter maintenance is four operations, all named

"Markers move outward" is the easy 5 %. Omit any of these and the front degrades
as it grows:

| Operation | FARSITE | Why it is not optional |
|---|---|---|
| **Density control** — insert/remove points to hold segment length | `StandardizePolygon::DensityControl` (`newclip.cpp:1787`); the resolution is the *mean active segment length*, floored at 1 m, divided by 1.4 for inward fires (`fsxwmech.cpp:540–578`) | A stretching perimeter loses resolution at the head and wastes it at the back |
| **Crossover / loop removal** — self-intersection | `Intersections::FindFirePerimeter`, `TurningNumberOK`, `CleanPerimeter`, `Cross` (`newclip.cpp`) | A front burning into a bay or around an island crosses itself; the hairiest algorithm in FARSITE |
| **Merging** — two perimeters into one | `PostFrontal::MergeFireRings` (`fsxpfront.cpp:2774`) | D6 |
| **Enclaves** — unburned islands inside the burn | `RemoveRingEnclaves`, `FillOuterRing` | See D8 |

### D8 — Burnable enclaves are declared out of scope for this phase

A *nonburnable* island is handled for free by D4's guard 2. A **burnable**
island — a bay that closes and leaves live fuel ringed by fire — needs inner
rings, which in FARSITE is a second class of perimeter with reversed
orientation. Out of scope for Phase 11; the stated artifact is that such a pocket
is treated as burned once the outer ring closes over it. This goes into
`docs/science.md` §9 as a *new* named gap, replacing the bullet this phase
closes. It is not swept under the rug.

### D9 — Determinism gets ordering rules and its own test

The raster sweeps cells in index order, which is a total order for free. A marker
front is not automatically ordered: perimeters, points and merges all need a
pinned sequence.

- Perimeters advance in **creation order**, points in **ring order** from a
  pinned start vertex, merges tested **pairwise in creation order**.
- No `Math.random()` — the invariant is unchanged, and nothing here wants RNG.
- `tests/determinism.test.ts` is on the CA path and stays untouched; a **new**
  determinism test on the Huygens path is the deliverable.
- No accumulation order may depend on iteration over a `Map`/`Set` whose layout
  depends on insertion history.

### D10 — `burnElapsed` and burnout are unchanged

Residence time is per-cell, cosmetic and spread-independent (Albini τ = 384/σ).
It starts where the rasteriser flips a cell and runs exactly as it does today.
Stated here so the diff is not searched for later.

---

## 5. The things that will go wrong, listed before they do

### 5a. Cost flips shape

Raster is O(front cells), tightly vectorised over typed arrays. Huygens is
O(perimeter points) with worse constants and no vectorisation, plus a per-tick
polygon rasterisation the raster path does not pay. The 16-accumulator array
(67 MB at `?size=1024`) goes away, which is the compensating win. **Profile only
with `npm run profile`** — vite-node/vitest timings are 5–10× wrong and
misattribute cost (CLAUDE.md).

### 5b. Substepping multiplies the work

D4's `cellSize/2` cap means a fast head under wind takes several substeps per
tick. That is the price of the containment guarantee, and it is charged per
marker rather than per cell.

### 5c. Intensity attribution changes meaning

Today `intensity[i]` is the fastest arriving **ray's** value. Under a sweeping
front it becomes the local rate of the **segment** that covered the cell — which
is where head-vs-flank starts to matter, since a flank segment is genuinely
cooler than the head. And cells swallowed wholesale by a **merge** were never
swept by any segment: they need the head-fire fallback (the `intensity[i] === 0`
branch, again). Getting this wrong shifts crown initiation (Van Wagner's I₀) and
ember production **silently** — nothing errors, the fire just crowns in the wrong
places. It needs its own test, not a visual check.

### 5d. The default is not obviously better for the sandbox

A smoother front is more faithful. It is not automatically a better *game*: the
raster's flank-narrowness is a conservative error, and its cell-grained edge
reads clearly at 30 m. `'raster'` stays the default until §7 says otherwise, and
flipping it is a separate argued decision — not a side effect of this phase
landing.

---

## 6. Staged delivery, with acceptance gates

Each stage must be runnable and verifiable before the next (CLAUDE.md).

**Stage 0 — extract the cell behaviour (D2).** ✅
`src/sim/surfaceBehaviour.ts`, and `RothermelFireModelOptions` split into a
shared `SurfaceBehaviourOptions` half and a raster-only half.
*Gate met:* suite unchanged (407 pass), `timber-crown-run` golden still
2552629230, `fire:rothermel` 0.594 → 0.574 ms/step on `shifting-winds` at 256².

**The plan's own §D2 sentence was wrong, and what shipped supersedes it.** It
asks for a pure function returning "head rate, head direction, eccentricity,
intensity and crown type" from `(world, cellIndex)`. Those are two different
scopes: the first three are per-*cell*, but intensity and crown type are
per-*direction* — the Byram intensity reads the direction's own rate off the
ellipse, and Van Wagner's I₀ test reads that intensity. A record-returning pure
function would have to evaluate the crown eagerly (a behaviour change: the FM10
proxy is deliberately deferred to the first direction that clears I₀, which most
cells never do) or allocate per direction (the hot loop allocates nothing per
direction). What shipped is a **two-phase stateful object** — `prepareCellEllipse`
then `ellipticalDirection(cosTheta)` — which is the shape the raster model
already had internally, and which the marker front reaches through the same two
phases: a marker's displacement gives `cosTheta = (d·headU)/|d|`.

**Stage 1 — one perimeter, no merging.** ✅
`src/sim/richards.ts` (the growth equations, pure), `src/sim/perimeter.ts`
(density control, area, point-in-ring, segment crossing, and the no-skip segment
traversal that paints the raster), `src/sim/huygensFireModel.ts`, and
`spreadEngine` on `Scenario`. **Barriers and external-ignition seeding came in
with it** rather than waiting for Stage 2 — seeding because a marker front has no
other way to *start* (every ignition arrives as a byte in the `fire` layer,
written by `igniteNearestBurnable`, the ignition tool, an ember or a backburn),
and barriers because the guard is two lines once seeding exists.

*Gate met:* all seven gates in `tests/huygens.test.ts` — the expansion test, the
signed oblique-axis test, the analytic rate, the shape pair, the barrier pair
(the line holds, a one-cell gap leaks) and both of §5c's intensity checks; plus
`tests/richards.test.ts` (10) and `tests/perimeter.test.ts` (11). §7's table is
measured below.

**One thing the plan did not anticipate: how to measure length-to-breadth.** The
ignition point is the ellipse's rear *focus*, not its centre, so the half-width
on the ray through the ignition point is the semi-latus rectum `b²/a` — and
`(head+back)/(2·that)` comes out as **LB²**, not LB. Measured that way both
engines read +96 % at 3 m/s, which is 1.91² = 3.65 and not a model error at all.
Breadth has to be the full extent *across* the head axis over the whole burn.

**And one gate the plan listed that does not transfer.** `tests/spread-ros.test.ts`
seeds a planar front by filling the whole left column, which is a raster idea: a
marker front has no perimeter there. The equivalent on this path is sharper and
is what `tests/huygens.test.ts` asserts instead — a point ignition's radius is
R₀·t at *every* angle, which is the rate check and the isotropy check at once.

**Stage 2 — merging (D6).** *(barriers (D4) and external ignitions (D5) landed in Stage 1)*
*Gate:* `tests/suppression.test.ts` passes unmodified on the Huygens path;
`tests/spotting.test.ts` passes; `timber-crown-run` runs a simulated hour without
producing a degenerate perimeter. Plus the merge half of §5c's intensity
attribution — after a merge, every cell inside the merged region carries a
**defined** intensity, nothing swallowed silently at zero. (§5c's *other* check,
that a flank segment records lower intensity than the head, and the barrier pair,
are both already pinned in `tests/huygens.test.ts` by Stage 1.)

**And a cost hazard that surfaces here, not in Stage 1.** Rings are never
retired, and burning does not change a cell's fuel id — so a marker inside the
burn scar still passes the burnable test and keeps moving, and a ring wholly
enclosed by burnt ground expands forever. Output stays correct (painting
short-circuits on an already-ignited cell); the cost does not. Retiring a ring is
part of merging, which is why they belong to the same stage. This is the reason
`timber-crown-run` is not measured in §7a.

**Stage 3 — crossover/loop removal (D7), and the decision on the default.**
*Gate:* a front driven around a nonburnable island produces a valid simple
polygon; the new determinism test is green; `npm run profile` inside the frame
budget at 512²; then the argued call on whether `'huygens'` becomes the default.

---

## 7. The claim to measure, stated before measuring

Repo culture: §3c recorded a prediction that failed and §10's Scott & Burgan
prediction was written down before it held. Predictions for Stage 1, to be
written up as-measured whether or not they hold:

| Quantity | Raster today | Predicted, Huygens |
|---|---|---|
| Windless max/min anisotropy | 1.087 | **≤ 1.02** |
| LB error at 1 / 1.5 / 2 / 2.5 / 3 m/s | +4 / +3 / +7 / +8 / +12 % | within **±5 %** across the series |
| LB error at 4 / 5 m/s | +4 / **+28 %** | **< 10 %** at 5 m/s |
| Radius at 11.25°, windless | 0.940 of due-east | **≥ 0.99** |

**Every row of this table is blind to a mirrored ellipse** (§2c). The direction
checks are not part of it and are not substitutable by it.

And the consequence nobody will like: the raster **understates** burned area
(§9), so a smooth front burns **more**. Predicted `timber-crown-run` burned area
at one hour: **+5 to +15 %** on the current 16 474 cells. The season pair's
**8.26×** area ratio was measured against the raster and will move; its direction
is deliberately **not** predicted — both members gain area, and the cured member's
spotting is intensity-driven, so the ratio can go either way.

### 7a. As measured (Stage 1)

Harness: `M:\claud_projects\temp\phase11\shape.ts` — FM1 at 6 % dead moisture,
flat, uniform, one lit cell, both engines on the *same* field, 300 ticks of
`dt = 1 s`, cell size chosen so the head travels 30 cells (windless) or 45 cells
(windy). Every "raster" figure below is re-measured on this harness rather than
quoted from `docs/science.md`, so the two columns are comparable to each other;
they are **not** directly comparable to §1's figures, which were taken on a
different geometry and, for length-to-breadth, a different definition.

**Every prediction held, and the anisotropy one held by an order of magnitude —
but only once the two things being measured were told apart.**

| Quantity | Predicted | Raster, measured | Huygens, **the front** | Huygens, painted raster |
|---|---|---|---|---|
| Windless max/min anisotropy | ≤ 1.02 | 1.080 | **1.0022** ✅ | 1.050 |
| Radius at 11.25°, windless | ≥ 0.99 | 0.959 | **0.9983** ✅ | 1.025 |
| LB error, 1 m/s | ±5 % | −3 % | **−0.4 %** ✅ | +2 % |
| LB error, 2 m/s | ±5 % | −0 % | **−1.0 %** ✅ | −2 % |
| LB error, 3 m/s | ±5 % | −2 % | **−1.8 %** ✅ | +0 % |
| LB error, 4 m/s | < 10 % | −1 % | **−3.0 %** ✅ | −5 % |
| LB error, 5 m/s | < 10 % | +12 % | **−4.4 %** ✅ | −8 % |
| Head rate / analytic | — | 0.939× | — | 1.006–1.028× |

**The two Huygens columns are the finding.** The last column reads the burned
cells out of the `fire` layer, exactly as the raster column does, and at a 30-cell
radius on 30 m cells one cell is 3 % — which a max/min over 32 rays picks up
twice. The middle column measures the model's own polygon, which is what Phase 11
actually changes. The front is essentially exact (1.0022 against a perfect
circle's 1.000); what is left in the last column is **the grid, not the front**,
and no propagation scheme can remove it. This distinction is not in §7 as written,
and the phase would have been reported as failing its own headline prediction
without it.

The residual over-run on the head rate (1.006–1.028×) is the seed ring: a new
perimeter is born as a ring of radius half a cell, which is 1.7 % of a 30-cell
run and 1.1 % of a 45-cell one. It is not a rate error.

**Burned area, same run, same field:** windless **1.135×** the raster's, at 3 m/s
**1.434×**. So the "a smooth front burns more" prediction holds, and the windless
figure lands inside the predicted +5 to +15 % band; the windy figure is well
outside it. That the wind-driven case gains most is the expected direction — the
raster's error was flank width, and flank width is what an elongated fire has
most of — but the magnitude was under-predicted. `timber-crown-run` itself is not
measured here: it needs perimeter merging (§D6), because it carries multiple
concurrent perimeters from its first ember, and that is Stage 2.

**The two direction gates, which the table above cannot see:** a windless ring
expands (burned area strictly increasing over six 20-tick windows), and under a
wind 30° off-axis the head lands at **31.0°** — against the raster's 27.9°, and
against the −30° a mirrored ellipse would have produced with every other number
in this document unchanged.

---

## 8. What goes stale — a deliverable, not a footnote

Because `'raster'` stays the default (D1), **nothing goes stale on landing** —
every number in `docs/science.md` was measured on the raster path, and that path
is byte-identical. The list below is what must be recomputed *if and when* the
default flips in Stage 3, written down now so that decision is taken with its
cost visible:

- `tests/fixtures/` — the `timber-crown-run` golden (16 474 cells at one hour).
- `docs/science.md` §1b's measured-shape row, and §9's first bullet (both figure
  sets).
- §3c's season-pair ratios (8.26× area, 2.47× mean intensity).
- §6's spotting figures are **downstream of burned area** and shift with it.
- The Phase-8/8b plan docs' measured tables — annotated, not rewritten: they
  document the raster, which still exists.

Doc edits that land **with this phase**: a new §1c in `docs/science.md`, sibling
to §1b, describing the marker front and its source; and §9's first bullet
**retargeted, not deleted** — the smooth-wavefront gap closes only on the Huygens
path, and D8's burnable-enclave gap opens in its place.

---

## 9. Steps

1. Stage 0: extract `src/sim/surfaceBehaviour.ts` from `RothermelFireModel` and
   split `RothermelFireModelOptions` into shared / raster-only; prove
   byte-identical.
2. `src/sim/richards.ts` — §2c in vector form, pure — plus
   `tests/richards.test.ts` against the analytic ellipse (a point ignition under
   steady wind must trace `R(θ) = R_head·(1 − E)/(1 − E·cos θ)`), **and the
   handedness/winding pair pinned by the expansion and oblique-axis tests**.
3. `src/sim/perimeter.ts` — pure polygon geometry: density control, area,
   point-in-polygon (crossing count, as `Rasterize::Overlap`), segment
   intersection (`StandardizePolygon::Cross`). `tests/perimeter.test.ts`.
4. `src/sim/huygensFireModel.ts` — Stage 1: advance, substep, rasterise.
5. `spreadEngine` on `Scenario`, wired in `loadScenario` beside the existing
   `fireModel` options; a preset for the shape harness.
6. Stage 1 measurement in `M:\claud_projects\temp\phase11\`; write §7's table
   as-measured.
7. Stage 2: barrier guard, external-ignition seeding, merging. Suppression and
   spotting tests on the Huygens path.
8. Stage 3: crossover removal, determinism test, profile, then the default call.
9. `docs/science.md` §1c + §9 retarget; update this doc's status; memory note.
