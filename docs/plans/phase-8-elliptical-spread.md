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

`tests/spread-shape.test.ts` pins both measurements so they stay known
approximations rather than unexamined artefacts, and `docs/science.md` §9 names
the 16-neighbour template (with the containment-line hazard) as the next step. A
marker-based Huygens front stays deferred (handoff §4.2).

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
