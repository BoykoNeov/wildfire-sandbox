# Phase 3 — Fuel-moisture dynamics (stub)

> **Status: forward stub, not in-flight.** This records the planned home for
> drying/wetting so the Phase-2 moisture work (`phase-2-science-anchor.md` D6)
> doesn't leave the dynamics undocumented. Flesh out when Phase 3 starts.

**Goal (roadmap §6 "P3 dynamic wind/rain/spotting"; handoff §4.1, §4.3):** make
the fuel-moisture layer *evolve* — fuels dry under sun/low humidity/wind and wet
under rain/high humidity — instead of being a static painted field.

## Architecture fit (additive — nothing in Phase 2 is rewritten)

- **A new system that *writes* `layers.moisture`.** Phase 2 (Step 3) gave the
  layer a physical byte↔fraction meaning and made it paintable; Phase 3 adds a
  system that *updates* those bytes each tick. The fire model still only *reads*
  moisture — systems talk through layers, never call each other (handoff §3.1).
- **Encoding unchanged.** It keeps reading/writing via `src/core/moisture.ts`
  (`byteToFraction`/`fractionToByte`, linear `0–255 ↔ 0.0–1.0`). No migration.
- **Determinism preserved.** Pure arithmetic over typed arrays driven by
  `IWeatherProvider` outputs and the seeded clock; no `Math.random()`.

## Sketch (decide for real at Phase-3 start)

- A simple equilibrium-moisture-content (EMC) relaxation: dead-fuel moisture
  drifts toward an EMC set by temperature + relative humidity, with a per-size-
  class time constant (1-hr fast, 10-/100-hr slow) — which is also the natural
  point to land **per-class dead moisture** (D6 item 1) if not already done.
- Rain adds moisture (capped at saturation); sun/wind accelerate drying.
- Inputs come from `IWeatherProvider` (handoff §3.3), so this couples to the
  same weather upgrade that brings time-varying wind.

## Interactions to keep straight

- **Live fuel moisture** is *not* this layer (live runs 100–300%; this byte is
  dead-fuel 0–1.0). If the dead/live split (Phase-2 D6 item 2) has landed, live
  moisture has its own representation and, if dynamic, its own (much slower)
  seasonal curve. See `phase-2-science-anchor.md` D6.
- **Spotting / rain** are the other Phase-3 pieces; moisture dynamics is the
  smallest of the three and a clean place to start.
