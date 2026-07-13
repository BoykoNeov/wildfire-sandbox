# Phase 3 — Fuel-moisture dynamics

> **Status: LANDED (first Phase-3 step).** Dead-fuel moisture now *evolves* toward
> an equilibrium set by ambient temperature + humidity, and wets under rain, each
> tick. The remaining Phase-3 pieces (time-varying wind, spotting) are still
> forward stubs — see the tail of this doc.

**Goal (roadmap §6 "P3 dynamic wind/rain/spotting"; handoff §4.1, §4.3):** make
the fuel-moisture layer *evolve* — fuels dry under low humidity/high temperature
and wet under rain — instead of being a static painted field.

## What shipped

- **`src/sim/emc.ts`** — a *pure* module: the **Simard (1968)** three-branch
  equilibrium-moisture-content regression (relative humidity %, temperature °F →
  EMC %). Literature-faithful (°F) with a metric `equilibriumMoistureFraction(rh,
  tempC)` wrapper for the sim. Coefficients cross-checked against multiple
  independent citations of Simard 1968 before use; pinned by `tests/emc.test.ts`
  with hand-worked vectors.
- **`WorldState.env` (`src/core/world.ts`)** — an ambient **`WeatherState`** scalar
  block (`temperatureC`, `relativeHumidity`, `rainRate`), written by
  `IWeatherProvider`, read by the moisture system. Uniform (map-wide) drivers live
  here as scalars; genuinely per-cell fields (wind) stay in `Layers`. `createWorld`
  seeds mild-weather defaults so a sim wired without a provider still reads defined
  values. **Not a sixth seam** — the five model seams are fixed by the handoff.
- **`UniformWeatherProvider`** now also fills `env` from optional constructor
  drivers (defaults 25 °C / 40% / no rain; existing `new …(u, v)` calls unchanged).
- **`src/sim/fuelMoistureSystem.ts`** — a plain `System` that writes
  `layers.moisture` each tick. Wired **weather → moisture → fire** in `main.ts`
  and `tools/renderFrame.ts`. Fire still only *reads* moisture (handoff §3.1).

## Architecture fit (additive — nothing in Phase 2 was rewritten)

- **A new system that *writes* `layers.moisture`.** Phase 2 (Step 3) gave the
  layer a physical byte↔fraction meaning and made it paintable; Phase 3 adds this
  system that *updates* those bytes each tick. Systems talk through layers/`env`,
  never call each other (handoff §3.1).
- **Encoding unchanged.** It reads/writes via `src/core/moisture.ts`
  (`byteToFraction`/`fractionToByte`, linear `0–255 ↔ 0.0–1.0`). No migration.
- **Determinism preserved.** Pure arithmetic over typed arrays (`Math.exp`, no
  `Math.random`) with a fixed row-major sweep. `tests/determinism.test.ts` (CA
  path, self-consistency) is untouched — no golden regen.

## The model (as built)

Fine dead fuel relaxes exponentially toward a target moisture `M*` with a
size-class time constant τ (forward-Euler-exact, dt-robust):

```
M ← M + (M* − M)·(1 − exp(−dt/τ))
```

- **Drying / normal:** `M*` = Simard EMC for the ambient T + RH; τ = **1 hr** (the
  1-hr fine dead-fuel timelag). This layer is the fine class — §D6 keeps a single
  dead moisture; the per-class 1-/10-/100-hr split stays a deferred model-side tweak.
- **Wetting / rain:** when `env.rainRate > 0`, `M*` = a saturation fraction (0.60)
  and τ is shorter (1800 s). This is the **least standardized** piece — EMC is
  well-defined science; precipitation response is not — so it is a deliberate
  **sandbox simplification**, not canon.

**Sub-byte precision + editor coexistence.** At dt = 1 s one tick moves moisture
far less than one Uint8 step (~0.4%), so integrating in byte space would stall on
rounding. The system keeps a private Float32 mirror carrying the sub-byte change
and writes the quantized byte each tick. Because the terrain editor can paint the
byte layer mid-run, before integrating it **adopts** any cell whose stored byte no
longer matches what it last wrote (the painted value wins) — same spirit as the
pre-tick buffer being authoritative for spread. Update is **in place** (each cell
depends only on its own prior value + uniform drivers; no neighbour reads → no
double-buffer needed).

**Verified (headless, 128² seed-1337):** a long dry run drives moisture toward
EMC (byte 36.6 → 21.9); rain from t=0 wets fuel past the Anderson dead
moisture-of-extinction band and prevents the fire establishing (455 → 2 burned).
Rain turned on *after* a front is moving plateaus its growth: +15 more cells (the
primed-`progress` cells noted below) vs +386 for a dry continuation. Moisture
moves on hour timescales, so this is *not* visible in a short browser session —
verify headless.

## Documented deferrals (Phase-3 refinements, not this step)

- **Solar/wind acceleration of the drying τ** (Nelson/Fosberg style) — deferred; RH
  + T via EMC is the dominant driver and enough for step 1.
- **Rain intensity-scaling** — `rainRate` currently gates wetting (`> 0`); making
  heavier rain wet faster is a cheap future refinement.
- **Per-class dead moisture** (1-/10-/100-hr apart) — deferred model-side tweak to
  `deadFuelBed()` distribution (Phase-2 plan D6 item 1). No encoding change.
- **Live fuel moisture** is *not* this layer (live runs 100–300%; this byte is
  dead-fuel 0–1.0). It has its own representation — a scenario-level scalar on
  `RothermelFireModel` (Phase-2 D6 item 2). A dynamic (slow, seasonal) live curve
  is a later addition, not here.

## The other Phase-3 pieces (still forward stubs)

- **Time-varying / spatially-varying wind.** The two fire models currently read
  wind from different cells: `RothermelFireModel` samples the *destination* cell,
  `CaFireModel` samples the *source* neighbour. Moot under today's uniform wind but
  diverges once wind varies — **settle a single convention when spatial wind lands.**
- **Spotting** — embers launched ahead of the front start new ignitions. The most
  complex of the three; moisture dynamics was deliberately the smallest and a clean
  place to start.
