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
| Performance | `prepareFuelBed` (everything independent of wind/slope) runs once per front cell; `spreadFromIntermediates` (the φ_w / φ_s half) once per neighbour direction. |

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
| Form | Fine dead fuel relaxes toward the Simard three-branch equilibrium moisture `M ← M + (M* − M)(1 − e^{−dt/τ})`, τ = 1 h. Under rain the target is a saturation fraction (0.6) with τ = 30 min — a **sandbox simplification**, precipitation response has no tidy standard. |
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
| Form | Per burning cell per tick: launch Bernoulli `p = 1 − e^{−k·canopy·wind·dt}`, exponential downwind loft distance (mean ∝ wind × canopy), ±20° scatter, moisture-gated reception below the landing fuel's M_x. Crown state multiplies launch rate ×3 (torching) / ×6 (active) and loft distance ×1.5 / ×2.5. |
| Not | Albini's firebrand-transport model, plume physics, brand burnout in flight. Model the consequence of the updraft, not the updraft. |
| Pinned by | `tests/spotting.test.ts` (embers cross an absolute firebreak, downwind only, no same-tick cascade, determinism), `tests/crownFire.test.ts` (crown-source boost). |

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

- **Elliptical / Huygens wavefront propagation.** The front is an 8-neighbour
  arrival-time CA: exact along the eight rays, ~8% slow between them, so
  perimeters are octagonal rather than elliptical. FARSITE-style Huygens
  expansion is a later fire model behind the same seam (handoff §4.2).
- **Per-size-class dead moisture.** One dead moisture (the 1-hr class) feeds all
  dead size classes. A 10-hr / 100-hr lag is a model-side tweak to
  `deadFuelBed` (plan §D6 item 1), still deferred.
- **Live fuel moisture dynamics.** A scenario scalar, not a seasonal curve.
- **Terrain-driven wind** (channelling, ridge acceleration) and any plume or
  fire–atmosphere coupling — CFD territory (handoff §2.1).
- **Per-cell canopy structure** (CBH / CBD / height layers) — scenario-level
  stand instead; import is the upgrade path (handoff §5.3).
- **Structures, WUI, industrial fuels** — the `IgnitableEntity` seam exists and
  is empty (handoff §5).
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
