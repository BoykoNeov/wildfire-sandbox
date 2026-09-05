# Wildfire & Firefighting Sandbox

A 2D, top-down, science-grounded wildfire and firefighting sandbox. You play an
**incident commander**: shape terrain, set ignitions and weather, watch fire
spread over a heightfield, and fight it with realistic doctrine.

It is a **sandbox**, not a validated predictor — real fire-spread models and
fuel models, plausible and instructive behavior, but *not* trustworthy for real
decisions. See [`wildfire-sandbox-handoff.md`](./wildfire-sandbox-handoff.md)
for the full design and rationale (read it before reversing any decision).

## Quick start

```bash
git clone git@github.com:BoykoNeov/wildfire-sandbox.git
cd wildfire-sandbox
npm install        # one-time
npm run dev        # interactive sandbox at http://localhost:5173
npm test           # headless sim tests (the architecture proof lives here)
npm run typecheck  # strict TypeScript, no emit
npm run frame      # headless: run the real sim and write frame.png
npm run frame -- timber-crown-run 3000 intensity   # any preset · steps · view
npm run profile    # where the time goes: ms/step per system, ms/frame per view
```

Open `http://localhost:5173/?scenario=timber-crown-run` (or pick a unit in the
HUD). Presets: **shifting-winds** (a wind shift flips the dangerous flank),
**grass-valley** (fast cured grass), **timber-crown-run** (torching → active crown
fire → long-range spotting), **rain-front** (a weather front stalls the fire).

## Architecture in one breath

- **World state** = plain data (typed-array layers + entities + clock + seeded RNG).
- **Systems** run once per tick and talk *only through the data layers*, never to each other.
- The sim is **headless** — it steps without drawing; the renderer reads world state but never drives the sim.
- Five swappable **seams** (`IFireModel`, `IFuelModel`, `IWeatherProvider`, `ISuppressionAgent`, `IRenderer`) abstract at the system/model boundary, never per-cell.

## What's modelled

Rothermel (1972 / Albini 1976) two-category surface spread over the Anderson 13
fuel models; Simard EMC dead-fuel moisture with a 1-hr timelag and rain; the
Albini–Baughman wind adjustment factor (20-ft wind → midflame, canopy-sheltered);
crown fire by Van Wagner initiation + Rothermel-1991 crown rate + crown fraction
burned; phenomenological spotting (crown runs throw far more embers); layer-only
suppression doctrine (line, backburn, knockdown, engines with a finite tank,
tankers with water / persistent retardant and a crown-fire falloff). Every
equation, its source, its test and every deliberate omission are in
[`docs/science.md`](./docs/science.md).

## Roadmap (see handoff §6)

Phase 1 core CA + seams → Phase 2 science anchor → Phase 3 dynamic world →
Phase 4 firefighting → Phase 5 polish (scenarios, stats HUD; save/load deferred)
→ Phase 6 science hurdles (intensity layer, wind reference, crown fire) → Phase 7
visuals & performance (part 1: faster step, smoke, contours, crisp overlays,
legend, profiler) — all landed; see [`docs/plans/`](./docs/plans/). Phase 7 part 2
is planned there. Structures/WUI and industrial fires are additive later phases.

## License

Boyko Non-Commercial License v1.0 (BNCL-1.0) — non-commercial use only; see
[`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE). Commercial licenses are
available separately from the copyright holder.
