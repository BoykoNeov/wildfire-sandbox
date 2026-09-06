# Science model card

What the sandbox actually computes, where each piece comes from, and what it
deliberately does **not** do. This is the honest-scope companion to the
handoff's "science-grounded, not validated/predictive" guardrail (§1): every
equation below is the operational one used by BehavePlus / FARSITE / FlamMap,
assembled the way those tools assemble it, and *none* of it has been calibrated
against a real burn. It teaches true things; it does not predict a fire.

Each row names the module that owns the maths and the test that pins it, so a
claim here can be checked in under a minute.

## 1. Surface fire spread — Rothermel (1972) with Albini (1976)

| | |
|---|---|
| Module | `src/sim/rothermel.ts` (pure; no world state) |
| Form | Two-category (dead / live) 1972 model as assembled in BehavePlus: per-category surface-area weighting, Albini SAV-size-class net loads, live moisture of extinction `M_x,live = 2.9·W·(1 − M_dead/M_x,dead) − 0.226`, reaction intensity summed over categories. `R = I_R·ξ·(1 + φ_w + φ_s) / (ρ_b·ε·Q_ig)`. |
| Outputs | Rate of spread (ft/min → m/s at the boundary), reaction intensity, Byram fireline intensity `I_B = I_R·R·τ/60`, flame length `L = 0.45·I_B^0.46`, residence time `τ = 384/σ`. |
| Units | Native imperial inside (every published constant was fitted that way), converted once at the module boundary (plan §D2). |
| Cross-checks | `tests/rothermel.test.ts` (emxsys/behave regression values), `tests/rothermel-twocategory.test.ts` (verbatim port of firelab/behave `surfaceFuelbedIntermediates.cpp` at zero wind/slope, hand-worked live M_x). |
| Performance | `prepareFuelBed` (everything independent of wind/slope) runs once per front cell — cached by fuel × dead-moisture byte. Under the default elliptical law (§1a) the wind/slope half also runs **once per cell**, not once per direction. |

## 1a. Directional spread — the fire ellipse (Anderson 1983; Alexander 1985)

Rothermel's `R` is a *head-fire* rate: the speed in the single direction of
maximum spread. Everything else comes from an ellipse.

| | |
|---|---|
| Module | `src/sim/fireEllipse.ts` (pure), applied in `src/sim/rothermelFireModel.ts` |
| Direction of max spread | Wind and slope combine **as vectors, once per cell**: `R_head = R₀ + \|R₀·φ_w·ŵ + R₀·φ_s·ŝ\|`, its azimuth being the head direction. Note `R₀ + \|v\|`, not `R₀·(1 + φ_w + φ_s)` — a cross-slope wind yields less than the scalar sum. Port of `SurfaceFire::calculateDirectionOfMaxSpread`. |
| Effective wind | Back-solved from the resultant by inverting Rothermel eq. (47): `U = ((φ_eff·(β/β_op)^E)/C)^(1/B)` [ft/min]. Slope steepens the fire exactly as an equivalent wind would. `SurfaceFire::calculateEffectiveWindSpeed`. |
| Length-to-breadth | `LB = 0.936·e^(0.1147·U) + 0.461·e^(−0.0692·U) − 0.397`, U in mi/h, capped at 8 (Anderson 1983; `FireSize::calculateSurfaceFireLengthToWidthRatio`). Crown fire uses Rothermel (1991) eq. 10, `LB = 1 + 0.125·U₂₀`. |
| Rate at an angle | `E = √(LB²−1)/LB`; `R(θ) = R_head·(1−E)/(1−E·cos θ)` — the ellipse about its **focus**, which is the right form for a front expanding from an ignition point (`SurfaceFire::calculateSpreadRateAtVector`, `FromIgnitionPoint`). Backing rate falls out as `R_head·(1−E)/(1+E)`. BehavePlus's other form (Catchpole et al. 1982) gives the rate normal to the perimeter and is not what an arrival-time CA wants. |
| Slope | A per-cell gradient (central differences on `elevation`, edge-clamped), not a per-ray rise: φ_s is a property of the site, and the vector sum needs one slope vector per cell. |
| Crown coupling | Evaluated **per direction** off the direction's own elliptical intensity, so a fire can crown at the head and stay a surface fire on the flanks. The FM10 proxy rate rides its own (rounder) crown ellipse about the same head direction. |
| Expect wider fires, not just longer ones | Every dimension of the ellipse scales with `R_head`, so the flank rate `R_head·(1−E)` comes out at **4–6× R₀** for a 2–3 m/s midflame wind. That is the model, not a bug: Anderson's LB is fitted to *observed* fire shapes, in which a wind-driven fire's flanks outrun a windless fire. Before Phase 8 the flanks were pinned at R₀ and the shape barely responded to wind at all. |
| Cross-checks | `tests/spread-shape.test.ts` — measured length-to-breadth against the analytic LB, measured backing/heading against `(1−E)/(1+E)`, and the no-wind degenerate case (`E = 0 ⇒ R(θ) = R₀`) matching the old per-direction law exactly. |
| Which directions exist | This law gives `R` for *any* θ; the raster can only travel along the sixteen rays of §1b, so how faithfully the burned region reproduces the ellipse is a separate question, answered there. |
| Escape hatch | `spreadShape: 'perDirection'` restores the Phase-2 law (project the wind onto each ray). Kept for comparison; it is not in any source and lets a fire back into the wind at the full no-wind R₀. |

## 1b. Propagation — the 16-ray template and its arrival accumulators

§1a says how fast the front goes in a given direction. This says which directions
exist, and how a cell decides it has been reached.

| | |
|---|---|
| Module | `src/sim/rothermelFireModel.ts` (`SpreadTemplate`, `collectCandidates`) |
| Template | 16 rays: the 8-ring (distance 1 and √2) plus the eight knight moves at ±26.57° / ±63.43° (distance √5). The knight rays exist because the spread ellipse's widest point sits ~18° off the head — *between* the 8-ring's 0° and 45° rays — so an 8-ray hull cut that corner and the fire came out too narrow. |
| Arrival rule | **One accumulator per ray.** Ray *n* advances by `R(θ_n)/(d_n·cellSize)` each tick and the cell ignites on the first ray whose integral reaches 1. That makes the front a shortest path over the 16-ray graph, which is what a finer angular template is worth anything to. Sharing one accumulator across rays (the Phase-2 law) double-counts a ray against itself-via-a-shorter-path and, with a √5 ray present, runs the fire **1.45× too fast**. Same family as Finney's minimum-travel-time raster template, and Dijkstra-shaped for the same reason. |
| Why not plain arrival times | `t_i = min(t_n + d/R)` is one float per cell instead of sixteen, but it is equivalent only at constant rates: it re-extrapolates from the neighbour's ignition time each tick, so a cell part-way across when the wind drops loses the progress it had invested. The accumulator integrates history, and dynamic wind (§8) is mounted in the presets. |
| Long moves cannot hop a line | A √5 step is the only move that clears ground — it passes *over* two cells without touching either as a neighbour. Both of them must be **burnable** or the ray is unavailable. Those two cells are the segment's supercover ((1, 0) and (1, 1) for a (2, 1) source), so any nonburnable barrier between source and destination must occupy one of {source, mid1, mid2, destination}: a knight move can never cross a barrier an 8-neighbour front could not, and the Phase-4 one-cell containment line still holds. The test is on **fuel, not fire state** — burnt-over ground was burnable fuel, and retardant re-pins moisture rather than fuel, so a drop slows a long ray without blocking it. |
| Candidate scan | Every cell within Chebyshev reach 2 of an ignited cell, via a separable dilation whose two passes are **sliding running sums** (one add and one subtract per cell), so the cost does not grow with the radius. The band is 5 cells wide instead of 3: mean candidates 955 → 1500 on `timber-crown-run` at 256². |
| Measured shape | Windless, ideal radius 25 cells: the fire is **inscribed** — 1.000 / 0.940 / 0.960 / 0.960 / 0.920 at 0 / 11.25 / 22.5 / 33.75 / 45°, max/min 1.087. Under wind, length-to-breadth error against Anderson: +4 / +3 / +7 / +8 / +12 / +4 / +28 % at 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 m/s, against the 8-ring's +4 / +3 / +7 / +8 / +12 / **+39** / **+61** %. Identical below 3 m/s; the whole gain is at LB > 2.4, and both stay narrow-biased (they understate burned area). |
| Cost | 16 `Float32` accumulators per cell: 4 MB at 256², 17 MB at 512², 67 MB at `?size=1024`. `fire:rothermel` runs 1.53 ms/step on `timber-crown-run` at 256² against the 8-ring's 0.91; the whole sim is 1.43 ms/step of a 16.67 ms frame. |
| Cross-checks | `tests/spread-shape.test.ts` (overspeed guard — no direction may exceed the ideal windless radius; isotropy; the LB gate at 5 m/s), `tests/spread-ros.test.ts` (the planar front still runs at the analytic Rothermel rate), `tests/suppression.test.ts` (a **one**-cell cut line holds, and a one-cell gap in it leaks) |
| Escape hatch | `spreadTemplate: 'ring8'` restores the Phase-2..8 law — 8 rays, one accumulator — **byte-for-byte**, verified against the pre-Phase-8b build on three presets. Kept because every earlier measured number in this document was taken against it, and because it is what `CaFireModel` still uses. |

## 2. Fuel — Anderson 13 (1982)

| | |
|---|---|
| Module | `src/sim/anderson13.ts`; terrain classes mapped by `src/sim/terrainFuelModel.ts` |
| Data | All 13 standard models transcribed from BehavePlus `fuelModels.cpp` (loads oven-dry lb/ft², SAV ft⁻¹, depth ft, dead M_x, 8000 BTU/lb). 10-hr / 100-hr SAV fixed at 109 / 30. |
| Terrain mapping | Generic terrain ids (grass / brush / timber) → Anderson numbers per scenario. Default FM1 / FM6 / FM9; the crown-run unit uses FM2 / FM4 / FM10. |
| Pinned by | `tests/anderson13.test.ts` |

## 3. Dead-fuel moisture — Simard (1968) EMC + 1-hr timelag

| | |
|---|---|
| Modules | `src/sim/emc.ts` (pure), `src/sim/fuelMoistureSystem.ts` |
| Form | Fine dead fuel relaxes toward the Simard three-branch equilibrium moisture `M ← M + (M* − M)(1 − e^{−dt/τ})`, τ = 1 h. Under rain the target is a saturation fraction (0.6) with τ = 30 min — a **sandbox simplification**, precipitation response has no tidy standard. Ticks shorter than 8 s are time-sliced (each row band integrated every K ticks over K·dt; exact for exponential relaxation, see the class header). |
| Encoding | `layers.moisture` is a Uint8 with a *linear* 0..255 ↔ 0..1 meaning (`src/core/moisture.ts`, plan §D6). Dead fuel only. Live moisture is a scenario scalar on the fire model. |
| Pinned by | `tests/emc.test.ts`, `tests/fuelMoisture.test.ts`, `tests/moisture.test.ts` |

## 4. Wind — reference height and the wind adjustment factor

| | |
|---|---|
| Module | `src/sim/windAdjustment.ts` (pure); option `windReference` on `RothermelFireModel` |
| Form | Albini & Baughman (1979) / Andrews (2012, RMRS-GTR-266). Unsheltered `WAF = 1.83 / ln((20 + 0.36H)/(0.13H))` with H the fuel-bed depth; sheltered `WAF = 0.555 / (√(f·H_c)·ln((20 + 0.36H_c)/(0.13H_c)))` with canopy height H_c and crown fill `f = cover·crownRatio/3`, used when f ≥ 0.05. |
| Convention | `windU/windV` are m/s in the wind field's own reference. `'midflame'` (default, plan §D3): used as-is. `'open'`: the reported 20-ft wind, reduced per **destination** cell (the cell the front spreads into — `tests/wind-convention.test.ts`). All presets use `'open'`. |
| Canopy semantics | The canopy byte is a *tree-overstory* cover / bulk-density proxy. Timber (200) shelters and can crown; brush (40) and grass (10) sit below the shelter threshold because shrub and grass crowns **are** the surface fuel bed. |
| Pinned by | `tests/windAdjustment.test.ts` (BehavePlus WAF table for FM1/3/4/5/8/10/12/13; sheltered hand-worked value; `'open'` ≡ `'midflame'`×WAF byte-for-byte). |

## 5. Crown fire — Van Wagner (1977, 1993), Rothermel (1991), Finney (1998)

| | |
|---|---|
| Module | `src/sim/crownFire.ts` (pure); evaluated per direction inside `RothermelFireModel.step` |
| Initiation | `I_0 = (0.010·CBH·(460 + 25.9·FMC))^1.5` kW/m. Surface fireline intensity at or above I_0 ignites the crown. |
| Active vs passive | `RAC = 3.0 / CBD` m/min (critical mass flow 0.05 kg/m²/s). Active if the Rothermel-1991 rate `R_active = 3.34·R_FM10(0.4·U_20)` reaches RAC, else passive (torching). |
| Blending | `CFB = 1 − exp(−a_c(R_s − R'_init))`, `a_c = −ln 0.1 / (0.9(RAC − R'_init))`; `R = R_s + CFB(R_active − R_s)`; `I = I_s + h_c·CBD·(H − CBH)·CFB·R` with h_c = 18 000 kJ/kg. |
| Canopy structure | One `CanopyStand` per scenario (stand height, crown ratio, crown base height, max bulk density, foliar moisture); a cell's CBD = canopy byte/255 × the stand maximum. Cells below `MIN_CROWN_CBD` (0.05 kg/m³) never crown. Per-cell CBH/CBD layers are a data-import concern (handoff §5.3). |
| Outputs | `layers.crown` (0 none / 1 passive / 2 active) and `layers.intensity` (kW/m), both written only by the fire model when a cell ignites. |
| Pinned by | `tests/crownFire.test.ts` — hand-worked I_0 / RAC, the none/passive/active classification, dry windy timber outruns the surface-only model with a recorded active run, no canopy / high moist crown / calm day / grass all stay surface fire, determinism. |

## 6. Spotting — phenomenological (handoff §2.1)

| | |
|---|---|
| Module | `src/sim/spottingSystem.ts` |
| Form | Per burning cell per tick: launch Bernoulli `p = 1 − e^{−k·canopy·wind·(L/L_ref)·dt}`, exponential downwind loft distance (mean ∝ wind × canopy), ±20° scatter, moisture-gated reception below the landing fuel's M_x. Crown state multiplies launch rate ×3 (torching) / ×6 (active) and loft distance ×1.5 / ×2.5. |
| Launch drive | `L = 0.45·I_B^0.46` (Byram/Albini flame length, §1) evaluated on the cell's recorded `layers.intensity`, divided by the flame length of a 1000 kW/m reference front. Flame length, not intensity itself, is the driver: it is the height brands are lifted from, and it maps the 10²–10⁵ kW/m range the sandbox produces onto a ≈0.5–8× band. A burning cell with no recorded intensity (legacy CA pipeline; a brand that landed after the fire model already ran this tick) falls back to exactly the reference rate. |
| Canopy and crown | Canopy is **brand availability and plume height** (bark, cones, lofted from crown height), no longer a stand-in for intensity. The crown multiplier survives on the same grounds: measured in `timber-crown-run`, crowning timber records ~700–900 kW/m against ~380 kW/m for the surface fire under it — ≈1.4× once flame length compresses it, far short of the ~6× a crown run actually spots at, because the extra brands come out of the canopy rather than out of the fireline. |
| Not | Albini's firebrand-transport model, plume physics, brand burnout in flight, intensity-driven **loft distance** (still wind × canopy × crown tier). Model the consequence of the updraft, not the updraft. |
| Pinned by | `tests/spotting.test.ts` (embers cross an absolute firebreak, downwind only, no same-tick cascade, determinism, launch rate scales ≈8× from a 300 to a 30 000 kW/m front matching L ∝ I^0.46, unscored cells fall back byte-identically to the reference front), `tests/crownFire.test.ts` (crown-source boost). |

## 7. Suppression — doctrine, layer-only (Phase 4)

Crews cut line (`fuel → CutLine`, nonburnable), set backburns, and hold an edge
with a small moisture knockdown; engines lay a wider, wetter knockdown from a
finite tank with a reload cycle; air tankers drop water (temporary, rides the
drydown) or retardant (a `retardant` layer re-pinned into `moisture` for hours),
with a crown-fire effectiveness falloff (`crownFalloffEffectiveness`). Nothing
un-burns a cell: every mechanic denies the front *unburned* fuel, which is what
lets suppression work whatever fire model is mounted. See
`docs/plans/phase-4-firefighting.md` and `tests/suppression.test.ts`
(the doctrine-pinning test: direct attack alone does not stop spread; a line does).

## 8. Weather and terrain

Wind: keyframed mean vector + a drifting coherent-noise gust field (own RNG, so
the sim's seeded stream is untouched); ambient temperature / humidity / rain as
keyframes. Terrain: seeded fractal value noise → elevation, fuel bands, canopy,
moisture. Slope enters Rothermel as rise/run along each neighbour direction,
upslope only.

## 9. What is *not* modelled (and why)

- **A smooth wavefront.** The *directional law* is elliptical (§1a) and
  *propagation* is now a 16-ray shortest path (§1b), but it is still a raster of
  finitely many rays, so the burned region is a 16-gon inscribed in the true
  shape rather than a smooth curve. Two measured consequences
  (`tests/spread-shape.test.ts`, `docs/plans/phase-8-elliptical-spread.md`):
  - *Windless:* a rounded 16-gon, 1.000 / 0.940 / 0.960 / 0.960 / 0.920 of the
    due-east radius at 0 / 11.25 / 22.5 / 33.75 / 45°, about 1.09 max/min. Every
    direction is at or **inside** the true circle. What is left is per-tick
    quantization rather than the graph metric: a cell fires on the tick its
    accumulator passes 1, so a ray whose crossing time is not a whole number of
    ticks always fires a little late.
  - *Windy:* measured length-to-breadth runs +3–12 % high up to LB ≈ 2, +4 % at
    LB 2.5 and +28 % at LB 3.2. The head (a ray) and the backing rate are
    accurate; the error is flank width, and it *understates* burned area.
  Before Phase 8b, with the 8-ray template, the same figures were 1.17 max/min
  windless — including a 10 % *overshoot* on the diagonals — and +39 % / +61 % at
  LB 2.5 / 3.2. `spreadTemplate: 'ring8'` still reproduces all of that
  byte-for-byte.
  A 32-ray template would keep shrinking the polygon defect at 4 floats per cell
  per added ray, with the same supercover gate on every long move; the honest
  next step is instead **FARSITE-style Huygens expansion** — marker points on the
  perimeter rather than a raster — which is a later fire model behind the same
  seam (handoff §4.2), not a wider stencil.
- **A one-cell *diagonal* barrier.** A nonburnable line laid corner-to-corner is
  leaked through by the √2 rays, because two cells meeting at a corner do not
  separate the plane and the diagonal rays are not supercover-gated (only the √5
  ones are — §1b). Pre-Phase-8b behaviour, unchanged; a line one cell wide in the
  cardinal sense holds against every ray in the template.
- **Rothermel's effective wind-speed limit.** BehavePlus optionally caps the
  effective wind at `0.9·I_R` (`SurfaceFire::calculateWindSpeedLimit`), which
  also clamps φ_s. Not applied here: it is a Rothermel-domain constraint on the
  head rate, orthogonal to fire shape, and turning it on would move head rates as
  well. Deferred rather than forgotten.
- **Per-size-class dead moisture.** One dead moisture (the 1-hr class) feeds all
  dead size classes. A 10-hr / 100-hr lag is a model-side tweak to
  `deadFuelBed` (plan §D6 item 1), still deferred.
- **Live fuel moisture dynamics.** A scenario scalar, not a seasonal curve.
- **Intensity-driven ember *loft distance*.** Launch rate now reads the recorded
  fireline intensity (§6), but how far a brand carries is still wind × canopy ×
  crown tier, not a plume-height function of intensity.
- **Terrain-driven wind** (channelling, ridge acceleration) and any plume or
  fire–atmosphere coupling — CFD territory (handoff §2.1).
- **Per-cell canopy structure** (CBH / CBD / height layers) — scenario-level
  stand instead; import is the upgrade path (handoff §5.3).
- **Structures, WUI, industrial fuels** — the `IgnitableEntity` seam exists and
  is empty (handoff §5).
- **Smoke.** The plumes the renderer draws are a *visual cue*: a downwind streak
  per flaming / smouldering cell, scaled by wind, recorded intensity and crown
  state, laid into a decaying screen-space field a quarter of the sources per
  frame (a rendering optimisation, not a transport model). No emission factors,
  no dispersion, no plume rise; nothing in the sim reads them
  (`src/render/palette.ts`, Phase-7 plan).
- **Validation.** No comparison against observed fires. Do not present a run as
  a prediction.

## 10. Conventions in one place

| Thing | Convention |
|---|---|
| Cell size | metres; default 30 m (0.09 ha) |
| Elevation | metres, Float32 |
| Moisture byte | linear 0..255 ↔ 0..1 dead-fuel fraction |
| Canopy byte | tree-overstory cover / bulk-density proxy (0..255); timber 200, brush 40, grass 10 |
| Wind field | m/s, vector points the way the wind blows; screen y grows south; reference height per `windReference` |
| Wind sampling | at the destination cell for spread; at the source cell for ember transport |
| `intensity` | kW/m of the arriving front, written at ignition; head-fire value for externally lit cells |
| `crown` | 0 / 1 / 2 = none / passive / active, written at ignition |
| Fire states | 0 unburned, 1 burning (flame residence τ), 2 burned — burned cells remain spread sources (plan §D4) |
| Determinism | every stochastic draw goes through `world.rng` in row-major order; renderers never touch it |
