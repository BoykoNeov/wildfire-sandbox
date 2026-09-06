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
| Cross-checks | `tests/rothermel.test.ts` (emxsys/behave regression values), `tests/rothermel-twocategory.test.ts` (independent verbatim port of firelab/behave `surfaceFuelbedIntermediates.cpp` + `surfaceFireReactionIntensity.cpp` at zero wind/slope, hand-worked live M_x). The port covers **all 53 standard models**: the Scott & Burgan half exercises bed shapes no Anderson model has — a live herbaceous *and* a live woody class together, the transferred fourth dead class, 1-hr SAVs at 750 — and agrees to ~1e-15 relative. Its literals are regenerable with `tools/sb40ReferencePort.mjs`, which is written from the C++ and never imports `rothermel.ts`. |
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

## 2. Fuel — the 53 standard models (Anderson 13 + Scott & Burgan 40)

| | |
|---|---|
| Modules | `src/sim/anderson13.ts`, `src/sim/scottBurgan40.ts`, shared machinery in `src/sim/fuelCatalogue.ts`; terrain classes mapped by `src/sim/terrainFuelModel.ts` |
| Data | All 13 Anderson (1982) models at numbers **1–13** and all 40 Scott & Burgan (2005, RMRS-GTR-153) models at **101–204**, transcribed from BehavePlus `fuelModels.cpp` (SAV ft⁻¹, depth ft, dead M_x, 8000 BTU/lb — 9000 for GR6). Anderson loads are oven-dry lb/ft² in the source; the Scott & Burgan rows are tons/acre there and keep those literals, converting by `2000/43560` in code, so a row still reads like the C++. 10-hr / 100-hr SAV fixed at 109 / 30 throughout. |
| Number ranges | Disjoint by design, so one lookup serves both (`STANDARD_FUEL_MODELS`) and a scenario may mix them freely. These are the numbers every other tool and every LANDFIRE raster uses. |
| Dynamic models | 17 of the 40 (all nine GR, all four GS, SH1, SH9, TU1, TU3) carry BehavePlus' `isDynamic` flag, which reaches the bed as `RothermelFuel.dynamic` and gates the herbaceous load transfer per model (§3c). All 13 Anderson models are static. Exactly the models with a live herbaceous load are flagged. |
| Terrain mapping | Generic terrain ids (grass / brush / timber) → model numbers per scenario. Default FM1 / FM6 / FM9 — deliberately still Anderson, since every measured number in this document was taken against it. The crown-run unit uses FM2 / FM4 / FM10; the season pair uses GR2 / GS2 / TU5. |
| Not transcribed | BehavePlus' regional (`SCAL*`), international (`V-*`, `M-*`) and non-burnable (`NB*`) rows. Two of those carry **different dead and live heat contents**, which the single-`heatContent` fuel bed cannot represent; all 53 standard models use one value for both, which is what makes that field honest (pinned). |
| Transcription note | TL5's live *woody* SAV reads `160` in `fuelModels.cpp` where the published table and every sibling row say 1600. TL5 carries no live woody load, so it is inert in every calculation; it is reproduced as the source has it rather than silently corrected, on the same principle as the residue in §3c. |
| Pinned by | `tests/anderson13.test.ts`; `tests/scottBurgan40.test.ts` — whose parameter check runs against `tests/fixtures/sb40-fuelModels.json`, **generated from the C++ by `tools/sb40Fixture.mjs`** rather than retyped, so it is a real check on the hand step and not a restatement of it |

The Anderson 13 remain the default and remain fully served; the second catalogue
is additive. What it buys is (a) a fuel vocabulary that distinguishes dry- from
humid-climate fuels, four grass-shrub bands, nine shrub models and nine litter
models where the 13 collapse them, and (b) — the reason it was built — models the
curing mechanic can actually act on: see §3c.

## 3. Dead-fuel moisture — Simard (1968) EMC + 1-hr timelag

| | |
|---|---|
| Modules | `src/sim/emc.ts` (pure), `src/sim/fuelMoistureSystem.ts` |
| Form | Fine dead fuel relaxes toward the Simard three-branch equilibrium moisture `M ← M + (M* − M)(1 − e^{−dt/τ})`, τ = 1 h. Under rain the target is a saturation fraction (0.6) with τ = 30 min — a **sandbox simplification**, precipitation response has no tidy standard. Ticks shorter than 8 s are time-sliced (each row band integrated every K ticks over K·dt; exact for exponential relaxation, see the class header). |
| Encoding | `layers.moisture` is a Uint8 with a *linear* 0..255 ↔ 0..1 meaning (`src/core/moisture.ts`, plan §D6). Dead fuel only. Live moisture is a scenario scalar on the fire model. |
| Pinned by | `tests/emc.test.ts`, `tests/fuelMoisture.test.ts`, `tests/moisture.test.ts` |

## 3a. Per-size-class dead moisture — the 10-hr and 100-hr classes

| | |
|---|---|
| Modules | `src/sim/anderson13.ts` (`deadFuelBed` / `fuelBed` take a `BedMoisture`), options `dead10hMoisture` / `dead100hMoisture` on `RothermelFireModel` |
| Form | The 1-hr class takes the cell's own moisture byte (§3). The 10-hr and 100-hr classes take **scenario-level constants** when given, and fall back to the 1-hr value when not. Rothermel already carries a moisture per fuel particle, so nothing in the spread math changed: the heat sink Q_ig, the surface-area-weighted dead category moisture in η_M, and Albini's fineness-weighted dead moisture inside M_x,live all pick the split up automatically. |
| Data | BehavePlus ships four standard dead triples (`moistureScenarios.cpp`): very low 3/4/5 %, low 6/7/8 %, moderate 9/10/11 %, high 12/13/14 %. Note how *narrow* those are — one to two percentage points between classes. |
| Pinned by | `tests/anderson13.test.ts` ("per-class dead moisture") |

**Why the coarse classes are constants and not a layer.** Their timelags (10 h,
100 h) are longer than a whole sandbox run, so within a burn they barely move —
what matters is the antecedent condition the run *starts* in, which is exactly
what BehavePlus asks its user for. An *offset* from the fine layer would be
actively wrong: the fine layer is dynamic on a 1-hour timelag, so a rain pulse
that drives the grass to 60 % would drag the logs up with it, which is the
opposite of the effect worth modelling.

**How big is the effect — measured, not assumed.** R₀ ratio against a uniform 6 %
dead bed, at 1-hr 6 % / 10-hr 15 % / 100-hr 25 % (a wet-heavy-fuel antecedent far
outside the standard triples, chosen to bound the effect):

| bed | R₀ ratio | fireline-intensity ratio |
|---|---|---|
| FM1 short grass, FM3 tall grass | 1.000 (one dead class — cannot change) | 1.000 |
| FM9 long-needle litter | 0.996 | 0.993 |
| FM2 timber grass | 0.994 | 0.989 |
| FM10 timber litter (the crown-fire bed) | 0.964 | 0.933 |
| FM6 dormant brush | 0.942 | 0.896 |
| FM12 medium slash | 0.913 | 0.853 |
| FM13 heavy slash | 0.891 | 0.811 |

**The crown-proxy bed sees the split too.** Rothermel's 1991 crown rate runs
Anderson FM10 as a stand-in for crown fuel at the *site's* moistures (§5), and
that bed is assembled by the same call, so the coarse dead classes move it as
well as the surface bed. This is deliberate — the crown proxy is a fuel bed like
any other — and given the intensity asymmetry below it is plausibly the larger of
the two routes by which per-class moisture changes a run. Foliar moisture is
separate and unaffected (it stays a canopy-stand property).

Two honest readings of that table. First, this is a **small** lever on spread
rate — under BehavePlus's own 6/7/8 triple the largest model moves 1.6 %, because
the heat sink weights each particle by exp(−138/σ): ≈ 0.93 for fine fuel, 0.28 at
the 10-hr SAV of 109, 0.010 at the 100-hr SAV of 30, and η_M weights the category
moisture by surface area, which punishes coarse fuel again. Second, it is roughly
**twice** the lever on fireline intensity, and intensity is what crown fire (§5)
and ember production (§6) threshold on — so the place it changes a *run* is
whether a stand torches, not how fast the flank creeps.

## 3b. Live-fuel moisture — the greenness curve

| | |
|---|---|
| Module | `src/sim/moistureScenarios.ts` (pure); options `greenness` / `liveHerbMoisture` / `liveWoodyMoisture` on `RothermelFireModel` |
| Data | BehavePlus's four standard live pairs (`moistureScenarios.cpp`): fully cured 30 % herb / 60 % woody, ⅔ cured 60/90, ⅓ cured 90/120, fully green 120/150. Woody runs 30 points wetter than herbaceous at every step. |
| Form | One knob, `greenness` ∈ [0, 1] (0 = fully cured, 1 = fully green), linear through both columns so all four standard rows come back exactly at 0, ⅓, ⅔, 1: `liveHerb = 0.30 + 0.90·g`, `liveWoody = 0.60 + 0.90·g`. Clamped outside the range. |
| Pinned by | `tests/moistureScenarios.test.ts` |

This also splits live **herbaceous** from live **woody**, which the bed had been
running at one shared value. As in §3a it reaches the FM10 crown-proxy bed as
well as the surface bed — FM10 carries live woody, so greenness moves the crown
rate too. Like the coarse dead classes (§3a) it is a scenario
input rather than sim state, and for the same reason: live fuel greens up and
cures over weeks, not over the minutes-to-hours a sandbox run covers.

**Why it is not called `curing`.** Curing has two halves. This knob is the
moisture one; the **load** one is §3c, which is off by default, so `greenness`
alone does not cure anything — it dries it. Naming it for the season rather than
for curing keeps that honest whichever way §3c is set.

## 3c. Herbaceous load transfer — curing's other half

| | |
|---|---|
| Module | `herbLoadTransferFraction` + the `herbLoadTransfer` bed option in `src/sim/anderson13.ts`; option `dynamicHerbLoad` and the per-fuel resolver `bedOptionsFor` on `RothermelFireModel` |
| Data | BehavePlus `surfaceFuelbedIntermediates.cpp`, `dynamicLoadTransfer()` — and `loadDead_[3]` / `savrDead_[3]` / `moistureDead_[3]` for where the transferred load lands |
| Form | Fraction of the live herbaceous load that has cured, read off the live herbaceous moisture in use: 1 below 30 %, `1.333 − 1.11·M` from 30 % to 120 %, 0 above. That load leaves the live category and becomes a **fourth dead class**, at the model's live-herbaceous SAV and the *fine* dead moisture. |
| Gate | Per **fuel model**, on the catalogue's own `isDynamic` flag (§2) — what BehavePlus does. `dynamicHerbLoad` overrides it in either direction: `true` forces the transfer on for every model (the Anderson extension described below), `false` forces it off for all, and *omitted is not the same as false*. |
| Default | Every one of the 13 Anderson models is static, so the default bed is byte-identical to the pre-Phase-10 one for every scenario that uses them. In the Scott & Burgan 40 the 17 dynamic models cure by default, which is the whole point of that catalogue. |
| Resolver | The transfer feeds both the spread bed and the flame-residence characteristic SAV, so the gate resolves in one place and both read it: a fuel has exactly one dead bed. Two non-issues: the prepared-bed cache needs no extra dimension (its key already contains the fuel id, and the gate is a function of the fuel id), and the FM10 crown proxy is unaffected either way because FM10 carries no herbaceous load. |
| Pinned by | `tests/anderson13.test.ts` ("herbaceous load transfer"), `tests/scottBurgan40.test.ts` ("the curing lever, measured") |

Cured grass is dry grass, so BehavePlus needs no separate curing input for the
standard models: the transfer reads the same live herbaceous moisture §3b sets.
Under the greenness curve that comes out as **f ≈ 1 − g** — one season knob
drives both halves. (Both halves read the *effective* live herbaceous moisture,
so a scenario that sets `liveHerbMoisture` directly, with no `greenness`, still
gets a consistent transfer.)

**Two transcription notes.** BehavePlus ships the middle branch as
`1.333 − 1.11·M` with the exact line through its own endpoints, `(1.20 − M)/0.9`,
commented out beside it. The shipped form is 0.001 rather than 0 at fully green;
that 0.1 % residue is reproduced rather than quietly corrected, so our numbers
match the reference. And BehavePlus gates the transfer on a model's `isDynamic`
flag, which **all thirteen** standard models fail — so switching it on here is an
extension of the Anderson catalogue, not a transcription of it. It is off by
default for that reason.

**Measured, and it does not do what the intuition says.** In the Anderson
catalogue only **FM2** carries a live herbaceous load at all (0.023 lb/ft²
against 0.161 of dead), so this is an FM2-only lever and inert in the other
twelve. On FM2, fully cured, turning it on takes R₀ to **0.957×** and fireline
intensity to **0.841×** — it makes the fire *smaller*, not bigger. The reason is
worth stating, because it is a real property of Rothermel's two-category algebra
rather than an artefact: moving a class between categories changes neither total
load, depth, packing ratio nor characteristic SAV, so the whole effect is in
which moisture of extinction the load is damped against. FM2's dead M_x is
**15 %**, its live M_x comes out near **1044 %** (§1), so the same grass is damped
0.56 as dead fuel at 6 % moisture and 0.93 as live fuel at 30 %. Declaring cured
grass dead is more honest than carrying it as barely-damped "live" fuel — it just
happens to slow the model down. It also coarsens the dead bed (characteristic SAV
2941 → 2784, the transferred class arriving at SAV 1500), so flame residence time
rises 1.057×.

So for the **Anderson** catalogue the load half is the *minor* lever and it pulls
against the moisture half: green → cured moves FM2's R₀ ×1.38 on moisture alone
and ×1.32 with the transfer on.

### The same mechanic in the Scott & Burgan 40 — measured

That FM2 result is a property of *that model*, not of the mechanic, and Phase 10
brought in the catalogue where the mechanic bites. The prediction written down
before measuring was "cured burns much more, the opposite direction from FM2",
because GR2 carries ten parts live herbaceous to one part dead where FM2 carries
one to seven. It holds, and by more than expected.

**Green → cured** (greenness 1 → 0, both halves, dead 6 / 10 / 9 %, midflame wind
350 ft/min), as a multiple of the green value:

| model | R₀ | fireline intensity |
|---|---|---|
| GR2 | ×50.2 | ×546 |
| GR4 | ×38.4 | ×327 |
| GS2 | ×10.4 | ×45.5 |
| TU1 | ×7.10 | ×22.8 |
| TU3 | ×3.02 | ×4.15 |
| *FM2, for scale* | *×1.32* | *×1.23* |

**Which half does the work.** Turning the transfer on and off with the season held
at fully cured isolates it. On the grass models it is the *dominant* half —
GR2 ×19.4 on R₀, GR4 ×14.9 — where on FM2 it is ×0.958. The share of the bed that
is herbaceous is what decides: GS2 ×1.54, TU1 ×1.06, and on **SH9** it goes
negative again at ×0.895 (R₀) and ×0.751 (intensity), because SH9 carries only 1.55
of its 15.5 tons/acre as herbaceous and its dead M_x is 40 %. The direction of this
half is a property of the model, not of the catalogue — §3c's original mechanism
is intact, it just usually points the other way here.

**The strongest form of the result: for a dynamic grass model the transfer is not
an enhancement, it is a precondition.** Left in the live category, GR2's
herbaceous load is damped against a live moisture of extinction that even 30 %
exceeds, so ~90 % of the bed contributes nothing and R₀ stays under 0.2 ft/min at
*every* season. Run the season pair with `dynamicHerbLoad: false` and the map
burns 0.2 ha in an hour instead of 92.9. This is why the gate follows the
catalogue by default rather than staying off: serving these models without the
transfer would be serving them wrong.

**And fully green grass does not carry fire at all.** At greenness ≥ 0.8 the
season pair's ignition dies inside five cells; burned area at one hour over the
greenness ladder runs 0.1 / 0.4 / 5.0 / 11.3 / 19.4 / 58 / 154 / 269 / 372 / 450 ha
at greenness 1.0 / 0.8 / 0.7 / 0.6 / 0.5 / 0.4 / 0.3 / 0.2 / 0.1 / 0 (GR2 grass,
SH5 brush, TU5 timber). Monotone, and steepest between 0.7 and 0.4. That is the
right physics and a useless scenario, which is why the shipped pair's green member
sits at 0.6 rather than 1.

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
| Module | `src/sim/spottingSystem.ts` (the system) + `src/sim/spotDistance.ts` (Albini's distance, pure) |
| Form | Per burning cell per tick: launch Bernoulli `p = 1 − e^{−k·canopy·wind·(L/L_ref)·dt}`, exponential downwind loft distance about a mean of `0.3 × survival × D_Albini`, ±20° scatter, moisture-gated reception below the landing fuel's M_x. Crown state multiplies launch rate ×3 (torching) / ×6 (active) and firebrand **height** ×1.6 / ×3.0. |
| Launch drive | `L = 0.45·I_B^0.46` (Byram/Albini flame length, §1) evaluated on the cell's recorded `layers.intensity`, divided by the flame length of a 1000 kW/m reference front. Flame length, not intensity itself, is the driver: it is the height brands are lifted from, and it maps the 10²–10⁵ kW/m range the sandbox produces onto a ≈0.5–8× band. A burning cell with no recorded intensity (legacy CA pipeline; a brand that landed after the fire model already ran this tick) falls back to exactly the reference rate. |
| Loft distance | Albini's maximum spotting distance for a wind-driven surface fire (Albini 1983 INT-309, as BehavePlus `spot.cpp` `calculateSpottingDistanceFromSurfaceFire` implements it), evaluated on the same recorded intensity. Three steps in Albini's native units: the thermal-energy-to-windspeed function `f = 322·(0.474·U)^-1.01`, the maximum firebrand height `z = 1.055·√(f·I_B)` ft, then flat-terrain drift `0.000718·U·√h·(0.362 + √(z/h)/2·ln(z/h))` plus the above-canopy term `0.000278·U·z^0.643`, both miles, with the cover height `h` floored at Albini's critical `2.2·z^0.337 − 4`. `U` is the **20-ft open** wind (backed out through the fuel's unsheltered WAF when the world layer is midflame, as the crown proxy does); `h` is the source cell's stand height × canopy fraction. Measured: at 10 m/s under 15.7 m of canopy a 1000 kW/m front reaches 339 m and a 30 000 kW/m front 1335 m — ≈3.9×, where the old wind × canopy × crown rule made them identical. |
| Brand burnout (the survival term) | The mean of the draw is `0.3 × (0.05 + 0.95·canopy) × D_Albini`. Albini's distance is how far a brand that *survives the flight* travels; timber sheds bark plates and cones that stay alight for minutes, grass and litter throw brands that burn out in seconds, and canopy is the only handle the sandbox has on which it is. Burnout caps flight *time* and distance is wind × time, so it scales the mean. **This is load-bearing, not cosmetic:** without it Albini's open-ground answer lets a fierce grass fire spot like crowning timber — measured 1.6 km throws, with 0.04-canopy sources producing 599 of `grass-valley`'s 673 spot fires and doubling its burned area. The 0.05 intercept (open fuels still throw *something*) is set so a grass cell keeps the previously tuned ~27 m mean reach. |
| Canopy and crown | Canopy now enters three times, for three different reasons, and they do not all pull the same way: brand **availability** (launch rate ∝ canopy), brand **durability** (the survival term above), and Albini's downwind **cover height** — which pushes the *other* way, since less cover to catch a brand means a longer throw. Plume height is no longer among them; it comes from the fire's own intensity through `z`. The crown multipliers survive on the original grounds: measured in `timber-crown-run`, crowning timber records ~700–900 kW/m against ~380 kW/m for the surface fire under it — ≈1.4× once flame length compresses it, far short of the ~6× a crown run actually spots at, because the extra brands come out of the canopy rather than out of the fireline. The loft multiplier moved from the *distance* to the firebrand *height*, which is where crowning physically acts (it is the burning-pile / torching-tree branch of Albini's model, `z = 12.2 × flame height` and `z = a·t^b·flame height + tree height/2`, that this system does not implement); distance is sub-linear in height, so ×1.6 / ×3.0 on `z` reproduce the old ×1.5 / ×2.5 on distance (measured 1.49× / 2.47× at the reference front). |
| Not | Albini's firebrand-transport model (particle size, burnout in flight — the survival term is a one-parameter stand-in, not a model of it), plume physics, the ridge/valley `spotDistanceMountainTerrain` correction, the burning-pile and torching-tree branches, BehavePlus' newer `CrownFirebrandProcessor`, and cover height sampled where the brand *lands* rather than where it launches (circular: the landing point is what the distance solves for). Model the consequence of the updraft, not the updraft. |
| Pinned by | `tests/spotDistance.test.ts` (every Albini sub-function against an independent transcription of the C++, in its own units; the SI chain end to end; the bracket clamp), `tests/spotting.test.ts` (embers cross an absolute firebreak, downwind only, no same-tick cascade, determinism, launch rate scales ≈8× from a 300 to a 30 000 kW/m front matching L ∝ I^0.46, unscored cells fall back byte-identically to the reference front, **embers from a fierce front land several times further downwind than from a marginal one**, and a canopy-free source throws far shorter than a timbered one at equal heat), `tests/crownFire.test.ts` (crown-source boost), `tests/scenario.test.ts` (the `timber-crown-run` golden). |

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
- **Spatially varying coarse dead moisture.** The 10-hr and 100-hr classes are
  now modelled (§3a) but as **map-wide constants**: only the fine class has a
  per-cell layer, so a wet valley and a dry ridge have equally dry logs. With
  map-uniform weather drivers the fine layer is the only spatial information the
  sim has, so this buys little; per-class layers would be the upgrade, at three
  moisture axes on the fire model's bed cache instead of one.
- **Coarse dead moisture *dynamics*.** The 10-hr and 100-hr values are held fixed
  for the run. That is defensible at sandbox run lengths (minutes to hours vs.
  timelags of 10 and 100 hours) and it is why they are scenario inputs rather than
  a system output — but a multi-day run would need them integrated.
- **Live fuel moisture *dynamics*.** There is a seasonal curve now (§3b), but it
  is evaluated once from a scenario knob, not integrated over a season. Same
  reasoning as the coarse dead classes: the swing is weeks long and a run is not.
- **Fuel models beyond the 53 standard ones.** The Scott & Burgan 40 landed in
  Phase 10 (§2), which closes the gap this list used to record here — curing now
  has 17 dynamic models to act on and moves the grass ones by 50× rather than
  16 % (§3c). What is still absent is *custom* fuel models: BehavePlus lets a user
  define a bed from scratch, and the regional (`SCAL*`) and international (`V-*`,
  `M-*`) rows it ships are not transcribed. Two of those carry different dead and
  live heat contents, which the single-`heatContent` fuel bed cannot represent, so
  that is a `rothermel.ts` change and not a table addition. Nothing in the sandbox
  needs it.
- **Firebrand transport as particle physics.** Loft *distance* now reads the
  recorded fireline intensity through Albini's plume height (§6), which closes
  the gap this list used to record here. What is still absent is the layer under
  it: a brand has no size, no mass and no burnout clock, so nothing decides
  *which* brands survive a long flight. The canopy-keyed survival term in §6 is a
  single-parameter stand-in for that, and it is doing real work — remove it and a
  grass fire spots 1.6 km, because Albini's relations describe a brand that
  survives, and over open ground with nothing to catch it that brand goes a very
  long way. Albini 1979's own firebrand model (particle diameter, burning rate,
  terminal velocity) is the honest upgrade; BehavePlus' `CrownFirebrandProcessor`
  is the modern one.
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
| Coarse dead moisture | scenario constants (`dead10hMoisture` / `dead100hMoisture`), fractions; default = the cell's 1-hr byte |
| Live moisture | scenario `greenness` 0..1 → herbaceous 30–120 %, woody 60–150 %; or per-class overrides |
| Herbaceous load transfer | opt-in (`dynamicHerbLoad`), fraction derived from the live herbaceous moisture in use; off ⇒ the static Anderson bed |
| Canopy byte | tree-overstory cover / bulk-density proxy (0..255); timber 200, brush 40, grass 10 |
| Wind field | m/s, vector points the way the wind blows; screen y grows south; reference height per `windReference` |
| Wind sampling | at the destination cell for spread; at the source cell for ember transport |
| `intensity` | kW/m of the arriving front, written at ignition; head-fire value for externally lit cells |
| `crown` | 0 / 1 / 2 = none / passive / active, written at ignition |
| Fire states | 0 unburned, 1 burning (flame residence τ), 2 burned — burned cells remain spread sources (plan §D4) |
| Determinism | every stochastic draw goes through `world.rng` in row-major order; renderers never touch it |
