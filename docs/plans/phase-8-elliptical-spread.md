# Phase 8 — Elliptical fire shape

> **Status: IN PROGRESS.** First of the "honest gaps" listed in
> [`docs/science.md`](../science.md) §9.

**Goal:** make the front's *directional* spread law the one operational fire
science actually uses — a wind/slope-driven ellipse — instead of the ad-hoc
per-direction wind projection Phase 2 shipped.

---

## The two defects hiding behind "the perimeter is octagonal"

They are independent, they have different fixes, and only the first is in scope.

### Defect 1 — the directional law is unprincipled (**this phase**)

`RothermelFireModel.step` evaluates each of the eight neighbour rays by
projecting the wind vector onto that ray (`along = max(0, d̂·w)`) and running
Rothermel with that reduced wind. That is not an ellipse and it is not in any
source. Two things are wrong with it:

- Every direction more than 90° off the wind gets `along = 0`, i.e. **the full
  no-wind R₀**. Real fires back into the wind at a small fraction of R₀. So the
  modelled fire is far too fat and far too eager upwind.
- Wind and slope are combined *per ray* (`1 + φ_w(ray) + φ_s(ray)`). Rothermel's
  own construction combines them **once, as vectors**, and the resultant defines
  a single direction of maximum spread.

### Defect 2 — the front is an 8-ray hull, not a smooth curve (**measured, documented, not fixed**)

Whatever `R(θ)` says, the front can only travel along eight rays, so the burned
region is the convex hull of the eight ray reach-points — a polygon inscribed in
the true shape.

**Measured, windless and flat** (radius by angle, ideal 25 cells, `npm`-free
harness in `M:\claud_projects\temp\phase8\profile.ts`):

| angle | 0° | 11.25° | 22.5° | 33.75° | 45° |
|---|---|---|---|---|---|
| r / r(0°) | 1.000 | 0.941 | 0.960 | 1.020 | **1.089** |

Note this is **not** the textbook weighted-8 octagon (which would be exact on the
rays and 92.4 % at 22.5°). The `progress` accumulator beats the graph shortest
path on the diagonals: a cell starts accumulating from its diagonal predecessor,
and when its *cardinal* neighbour ignites shortly after it switches to that
neighbour's faster rate, arriving earlier than any single path allows. So the
windless fire is a rounded square bulging ~9 % on the diagonals and running ~6 %
short at 11.25°, a total anisotropy of about 1.16 max/min. Both spread laws give
**identical** radii here — this is the CA's geometry, untouched by Phase 8.

**Measured, with wind** — how faithfully the raster reproduces Anderson's LB:

| midflame wind | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 m/s |
|---|---|---|---|---|---|---|---|
| analytic LB | 1.21 | 1.34 | 1.51 | 1.69 | 1.91 | 2.46 | 3.19 |
| measured LB | 1.25 | 1.38 | 1.61 | 1.83 | 2.15 | 3.42 | 5.13 |
| error | +4 % | +3 % | +7 % | +8 % | +12 % | +39 % | +61 % |

The error is all in the **flank width**: the head sits on a cardinal ray and is
exact, the backing rate is within a few percent (0.0250 vs 0.0258 at 5 m/s), but
the ellipse's widest point sits at ~18° off the head, between the 0° and 45°
rays, where the hull cuts the corner. The raster fire is therefore *too narrow*,
increasingly so above LB ≈ 2.5 — a conservative error (it understates burned
area) rather than an invented behaviour.

**Decision — keep the 8-neighbour template.** Two reasons:

1. **Knight moves hop containment line.** Ground crews suppress by clearing fuel
   from cells; a 1-cell-wide line stops an 8-neighbour front. A √5 move steps
   *over* it. A 16-neighbour template would silently break the Phase-4 doctrine
   unless every long move tested its intermediate cells for burnability — and it
   would widen the candidate dilation from 3×3 to 5×5, growing the candidate
   list on every tick, for a gain confined to LB > 2.5.
2. **What it replaces was infinitely worse.** The old law's measured LB is
   1.50 / 1.54 / 1.54 at 2 / 3 / 5 m/s — a fire whose shape does not respond to
   wind *at all*. Over-elongated-but-responsive is a categorically better error
   than shape-blind.

> ### ⟶ REVERSED in Phase 8b — see [§ Phase 8b](#phase-8b--the-16-ray-template)
>
> The template **was** added, at the user's direction, with both stated
> objections paid off: every knight move now tests the two cells it steps over
> (measured: without that gate a one-cell line leaks 299 cells; with it, zero),
> and the 5×5 dilation was made affordable by rewriting both passes as sliding
> running sums. Reason 2 stands unchanged — it is why `'ring8'` is kept as a
> byte-identical escape hatch rather than deleted.
>
> The decision above also **missed the real obstacle**, which was neither of the
> two it names: a 16-ray template on the Phase-2 single accumulator runs 1.45×
> too fast. That, not the knight-hop, is what made this a propagation change and
> not just a wider stencil. Written up below.

`tests/spread-shape.test.ts` pins both measurements so they stay known
approximations rather than unexamined artefacts. A marker-based Huygens front
stays deferred (handoff §4.2).

---

## The model, from `firelab/behave`

Fetched at implementation time (per the `rothermel-reference-sources` memory —
published coefficients are never taken from recall). Sources:
`src/behave/surfaceFire.cpp` and `src/behave/fireSize.cpp`.

### 1. Wind and slope combine as vectors → head rate and its direction

`SurfaceFire::calculateDirectionOfMaxSpread`, in a frame whose x-axis is upslope:

```
slopeRate = R₀·φ_s          windRate = R₀·φ_w
x = slopeRate + windRate·cos(θ_wind)      y = windRate·sin(θ_wind)
R_head = R₀ + √(x² + y²)                  azimuth = atan2(y, x)
```

Note `R₀ + |v|`, **not** `R₀·(1 + φ_w + φ_s)`: the two factors add as vectors, so
a cross-slope wind yields less than their scalar sum. We do the same sum in world
(x, y) coordinates with an explicit upslope unit vector, which is the same
computation without the aspect bookkeeping.

### 2. Effective wind speed, back-solved

`SurfaceFire::calculateEffectiveWindSpeed` — the wind that *alone* would produce
the resultant factor, by inverting Rothermel eq. (47):

```
φ_eff = R_head/R₀ − 1
U_eff = ((φ_eff · (β/β_op)^E) / C)^(1/B)        [ft/min]
```

### 3. Length-to-breadth ratio and eccentricity

`FireSize::calculateSurfaceFireLengthToWidthRatio` (Anderson 1983), **U in
mi/h**, capped at 8 as BehavePlus does:

```
LB = 0.936·e^(0.1147·U) + 0.461·e^(−0.0692·U) − 0.397      (LB = 1 at U = 0)
E  = √(LB² − 1) / LB
```

Crown fire gets its own ratio (Rothermel 1991 eq. 10): `LB = 1 + 0.125·U₂₀`.

### 4. Rate at an angle — the ellipse at its focus

`SurfaceFire::calculateSpreadRateAtVector`, `FromIgnitionPoint` mode:

```
R(θ) = R_head · (1 − E) / (1 − E·cos θ)          θ from the head direction
```

Behave has a second form (Catchpole et al. 1982) for the rate *perpendicular to
the perimeter*, used for fireline intensity at a point on the fire edge. Ours is
an **arrival-time** front growing from an ignition point, so the focus form is
the right one. Back rate falls out as `R_head·(1−E)/(1+E)`, matching
`FireSize::calculateBackingSpreadRate`.

---

## How it lands in the fire model

An **option**, not a new class — the `windReference` / `crownFire` precedent:

```ts
spreadShape?: 'elliptical' | 'perDirection'   // default 'elliptical'
```

The old path stays reachable so its tests keep meaning and a byte-diff is
possible. Per candidate cell the elliptical path does:

1. one prepared bed (already cached by fuel × moisture byte),
2. one φ_w from the **full** midflame wind magnitude and one φ_s from the cell's
   own slope,
3. the vector sum → `R_head`, head unit vector, `U_eff`, `LB`, `E`,
4. eight scalar `(1−E)/(1−E·cos θ)` evaluations.

That replaces **eight** Rothermel evaluations per cell with one.

**Measured — it is ~10 % dearer per cell, not cheaper.** On an identical front
(a burned disc of radius 150 on a 512² map, re-stamped every tick so both laws
see exactly the same candidate set) the fire model costs 1.94 ms/step under
`perDirection` and 2.13 ms/step under `elliptical`. The saving on Rothermel
evaluations is real but smaller than it looks: most rays into a candidate cell
have no ignited neighbour or blow upwind (where the old law skipped the wind
`pow` entirely), while the elliptical setup adds ~4 transcendental calls per cell
(the effective-wind back-solve is a `pow`, the length-to-breadth ratio two
`exp`s). Two things were done about it, and are worth keeping in mind before
adding more per-cell work here:

- the FM10 crown proxy's head rate is computed **lazily**, only once a direction
  actually clears Van Wagner's I₀ (`ensureCrownHead`) rather than for every
  crown-capable cell — worth ~9 % on its own;
- the residence time τ is hoisted to the cell instead of being re-derived per
  ray, associated exactly as `firelineIntensity` does so the result is unchanged
  bit-for-bit.

In an actual scenario the model runs *faster* than before (1.74 vs 2.01 ms/step
on `timber-crown-run` at 512²) — but only because the elliptical fire is
narrower and so there is less front to sweep. Both numbers are the honest ones;
neither is a speedup claim. Nothing is near the frame budget either way.

### Design decisions

**Slope becomes a per-cell gradient.** The old path read `elev[i] − elev[ni]` per
ray, clamped upslope-only. The ellipse needs one slope vector per cell, so the
model takes central differences on `elevation` (edge-clamped) and uses the
magnitude for φ_s and the uphill direction for the vector sum. This is more
faithful to Rothermel — the slope factor is a property of the *site*, not of the
ray the fire happens to arrive along — but it **is** a behaviour change on
terrain, and it is the reason a fire now spreads uphill fastest even when its
nearest ignited neighbour is off to one side.

**Crown fire is evaluated per direction, not head-only.** The Van Wagner I₀ test
reads surface intensity, which now varies smoothly with θ, so a fire can crown at
its head and stay a surface fire on its flanks — which is what torching fires
actually do. The FM10 proxy rate gets its own crown ellipse (Rothermel-1991 LB)
about the same head direction. Cost is one extra head evaluation per crown-capable
cell; the per-direction work stays scalar.

**Recorded intensity uses the focus-form rate.** `layers.intensity` records the
Byram intensity of the direction that actually ignited the cell, computed from
that direction's `R(θ)`. Behave would use the Catchpole perpendicular rate for
intensity at a perimeter point; we record what the front *did* into this cell,
which is the focus form. Documented rather than silently mixed.

**The effective-wind-speed limit is NOT applied.** BehavePlus optionally caps the
effective wind at `0.9·I_R` (`calculateWindSpeedLimit`). It is a separate
Rothermel-domain constraint, orthogonal to fire shape, and turning it on would
move head rates as well as shape. Left for a later pass; recorded in §9.

---

## Acceptance

Two new shape tests, plus the existing gates:

- **`tests/spread-shape.test.ts` — isotropy.** Point ignition, flat, windless:
  the radius profile at nine angles must be **identical** under both laws (the
  degenerate-case proof: E = 0 ⇒ R(θ) = R₀), and its max/min must stay inside
  the measured 1.16.
- **`tests/spread-shape.test.ts` — aspect.** Point ignition, flat, uniform wind:
  along-wind extent vs across-wind extent must approach the analytic `LB`, and
  the backing extent must approach `(1−E)/(1+E)` of the heading extent.
- **`tests/spread-shape.test.ts` — wind response.** The old law's measured LB is
  flat across 2 → 5 m/s; the new law's roughly triples. That flatness is the
  actual reason this phase exists.
- **`tests/spread-ros.test.ts` must pass unchanged.** No wind, no slope ⇒ LB → 1,
  E → 0, R(θ) → R₀. If that moves, the degenerate case is wrong.
- Tests that legitimately move because backing spread is now slow:
  `fireSpread`, `intensity`, `spotting`, `wind-convention`, `stats`. Each change
  is justified in the commit, not absorbed by loosening a tolerance.
- `tests/determinism.test.ts` is unaffected — its golden runs the Phase-1
  `CaFireModel`, not this one.

---

# Phase 8b — the 16-ray template

> **Status: SHIPPED.** Reverses the "keep the 8-neighbour template" decision
> above. Defect 2 (the 8-ray hull) is now narrowed, not merely measured.

`spreadTemplate?: 'ring8' | 'template16'` — default `'template16'`. One axis, two
coherent laws, exactly as `spreadShape` is: the template and the accumulator that
goes with it change together, because (as below) they are not independent.

## What the extra rays are for

The spread ellipse's widest point sits ~18° off the head. The 8-ray hull has rays
at 0° and 45° and nothing between, so it cuts that corner and the fire comes out
too narrow — increasingly so as the aspect ratio rises. The knight moves
(±26.57° / ±63.43°, distance √5) land close to the widest point.

Note what the extra rays are **not** for: a knight ray never buys the front
*reach*. Whenever the supercover gate below lets one through, a two-step route
exists alongside it (√2 + 1 = 2.414 cell-widths) and the knight is merely shorter
(√5 = 2.236). The whole template is a **7.4 % finer metric** at 26.57°.

## Obstacle 1 (foreseen) — a √5 step hops a one-cell line

A knight move is the only move in the template that does not touch its
destination's edge or corner: it steps *over* two cells. A one-cell-wide cut line
stops every 8-ray front, so letting a knight ray ignore what it crosses would have
silently voided the Phase-4 containment doctrine.

**The gate.** Both cells the segment passes over must be burnable, or the ray is
unavailable. For a (2, 1) source they are (1, 0) and (1, 1): the segment leaves
(1, 0) at x = 1 as y crosses ½ and enters (1, 1) — i.e. the segment's
*supercover*. Requiring both is what makes the guarantee exact: any nonburnable
barrier separating source from destination must occupy one of
{source, mid1, mid2, destination}, so a knight move can never cross a barrier an
8-neighbour front could not.

Two details that matter:

- **The test is on fuel, never fire state.** Burnt-over ground *was* burnable fuel
  and a knight move across it is legitimate; gating on `fire[]` would make the
  front stall behind its own burn scar. Retardant re-pins moisture rather than
  fuel, so a drop slows a long ray without blocking it — correct, and worth saying
  out loud so nobody later reads it as a bug.
- **Burnability is read from a 256-entry table**, not through
  `IFuelModel.getParams`: the gate runs twice per long ray in the hot loop, and a
  per-cell virtual call there is exactly what the architecture invariants forbid.
  A fuel *id*'s burnability never changes — suppression rewrites the id at a cell,
  not the meaning of the id — which is the same caching argument as `bedCache`.

Pinned by `tests/suppression.test.ts` ("a ONE-cell line holds"), which cuts a
*single* column — the existing 4a gate cuts two, which no ray in either template
can cross, so it would never have caught this. Measured with the gate disabled:
299 cells ignite past the line. With it: zero. A one-cell gap in the same column
still leaks, so the assertion is about the barrier and not about a front that was
never going to arrive.

**Not fixed, and pre-existing:** a purely *diagonal* one-cell line still leaks
through the corner cut, because the √2 rays are ungated and two cells meeting at a
corner do not separate the plane. That is Phase-4 behaviour, unchanged here.

## Obstacle 2 (not foreseen) — the accumulator overspeeds by 1.45×

This is the one the decision above missed, and it is the reason Phase 8b is a
propagation change rather than a wider stencil.

The Phase-2 accumulator advances one `progress` value per cell by the **fastest
rate available at that instant**. Add the knight rays and a cell picks up credit
from its knight neighbour two columns back — which lights a whole crossing-period
early, at 1/√5 of the cardinal rate — and then adds the cardinal rate on top when
the nearer neighbour lights. Steady state:

```
P/T = 1 − (1/√5)·(P/T)   ⇒   P = T/(1 + 1/√5) = 0.69 T
```

i.e. **1.45× too fast**. Measured on a windless point ignition whose ideal radius
is 25 cells: radii of 33–36, or +32 % to +44 %, in every direction. That breaks
the model's core invariant — the front's speed *is* the Rothermel rate — and would
have taken `tests/spread-ros.test.ts` with it.

The 8-ring escapes this only because its longer ray (√2) is never available
earlier than its shorter one.

**No admissibility rule can fix it.** Several were tried on paper — use the knight
ray only when the intermediates are unburnt, only when they *are* burnt, only when
no shorter ray is available. Each fails, and for the same structural reason: the
double count is between a ray and *itself via a shorter path*, so gating which
rays are admissible cannot touch it. A finer metric is only worth something to an
algorithm that computes a metric, and an integral over overlapping routes is not
one. (This is why Finney's minimum-travel-time raster template is Dijkstra-shaped.)

**The fix: one accumulator per ray.** Ray *n* completes when `∫ rate_n dt` reaches
1; the cell ignites on the first ray to get there. No ray can hand credit to
another, so the front is a shortest path over the 16-ray graph again:

- planar front — cardinal completes in `T = cellSize/R`, knight in `2.236 T`, so
  the cardinal fires first and the measured speed is exactly R;
- 26.57° off a point ignition — knight arrives at `2.236 T` against `2.414 T` for
  either two-step route, so the shape gain survives.

Two alternatives were measured and rejected:

- **Plain arrival-time relaxation** (`t_i = min(t_n + d/R)`, one float per cell)
  is equivalent *only for constant rates*. It re-extrapolates from the neighbour's
  ignition time every tick, so a cell 60 % across when the wind drops loses the
  progress it invested. Integrating history is the accumulator's one genuine
  virtue, and Phase-3 dynamic wind is mounted in the presets.
- **Three accumulators, one per distance class** (1 / √2 / √5, 12 bytes/cell)
  fixes the speed but not the shape: the head-ward and flank-ward rays of the
  *same* length still trade credit, which measured 8–17 % **wide** — worse than
  `'ring8'` below 4 m/s. Splitting by distance is not enough; it has to be by ray.

Cost: 16 `Float32` per cell instead of 1 — 4 MB at 256², 17 MB at 512², 67 MB at
`?size=1024`. `'ring8'` is the escape hatch if that ever matters.

## Measured — what the template actually bought

Windless point ignition, flat, ideal radius 25 cells (radius / radius at 0°):

| angle | 0° | 11.25° | 22.5° | 33.75° | 45° | max/min |
|---|---|---|---|---|---|---|
| `ring8` | 1.000 | 0.940 | 0.960 | 1.020 | **1.100** | 1.170 |
| `template16` | 1.000 | 0.940 | 0.960 | 0.960 | 0.920 | **1.087** |

The 8-ring's entries above 1 are the accumulator beating the graph shortest path;
per-ray accumulators remove them, so the 16-ray fire is **inscribed** — it reaches
R₀·t on the rays and falls short between them, never past. What remains is
per-tick quantization, not the graph metric: a cell fires on the tick its
accumulator passes 1, and here a cardinal step is exactly 4 ticks while a diagonal
takes 4√2 = 5.66 and rounds to 6.

Length-to-breadth against the analytic Anderson value:

| midflame wind | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 m/s |
|---|---|---|---|---|---|---|---|
| analytic LB | 1.21 | 1.34 | 1.50 | 1.69 | 1.91 | 2.46 | 3.19 |
| `ring8` | +4 % | +3 % | +7 % | +8 % | +12 % | **+39 %** | **+61 %** |
| `template16` | +4 % | +3 % | +7 % | +8 % | +12 % | **+4 %** | **+28 %** |

**Identical up to 3 m/s.** Below LB ≈ 2 the ellipse's widest point is close enough
to the 45° ray that the extra rays buy nothing; the entire gain is above it, which
is exactly where the old error was worst. Both remain *narrow*-biased, i.e. they
understate burned area — the conservative direction. The phase-8 decision's "a
gain confined to LB > 2.5" was, on the numbers, right.

## Cost

Per-candidate work roughly doubles (16 rays, not 8) and the candidate band widens
from 3 cells to 5 (mean candidates 955 → 1500 on `timber-crown-run` at 256²,
195 → 432 at 512²). Against that, both O(map) dilation passes were rewritten as
**sliding running sums** — the count of ignited cells in the ±r span is carried
cell to cell by one add and one subtract, so the cost no longer grows with the
radius — and the separate ignited-mask pass was folded into the horizontal one.
At 512² with a small fire those passes, not the sweep, *were* the fire model's
whole cost.

Net, `fire:rothermel`:

| | HEAD (8-ray) | `template16` | `ring8` |
|---|---|---|---|
| `timber-crown-run` 256², 3000 steps | 0.910 ms/step | 1.532 | 0.790 |
| `timber-crown-run` 512², 1800 steps | 1.291 | 1.730 | 1.357 |
| `shifting-winds` 256², 1500 steps | 0.277 | 0.300 | 0.317 |

Read those as approximate: the shape change alters how much front there is, so the
runs being compared are not burning identical areas. `ring8` is at parity with
HEAD or better *despite* the rewritten dilation, which is the useful control.
`npm run profile` puts the whole sim at 1.43 ms/step at 256² and 2.78 ms/step at
512², against a 16.67 ms frame — nothing is near the budget, so item G (a WebGL
renderer) stays unnecessary.

## Acceptance

- `tests/spread-shape.test.ts` — **overspeed guard** (new): no direction may
  exceed the ideal windless radius; the 16-ray front is inscribed while the
  8-ring overshoots on the diagonal. This is the assertion that catches obstacle 2.
- `tests/spread-shape.test.ts` — isotropy re-pinned at 1.087, and asserted
  strictly rounder than `'ring8'`.
- `tests/spread-shape.test.ts` — **wind response re-pinned against the analytic
  LB ratio**, not the old measured constant. The previous `> 2.5` bound was
  inflated by the very hull error this phase removes, so keeping it would have
  been pinning the discretization.
- `tests/spread-shape.test.ts` — **new acceptance gate**: at 5 m/s the 16-ray LB
  error must be under half the 8-ray one.
- `tests/spread-ros.test.ts` passes **unchanged** — the planar front still runs at
  the analytic Rothermel rate.
- `tests/suppression.test.ts` — the one-cell line gate described above.
- `tests/scenario.test.ts` — the `timber-crown-run` golden hash is recomputed
  (382468332 → 2410933397); the old value is still reachable byte-for-byte as
  `spreadTemplate: 'ring8'`, verified against HEAD on three presets.
- `tests/determinism.test.ts` unaffected — its golden runs the Phase-1
  `CaFireModel`.
