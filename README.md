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
```

## Architecture in one breath

- **World state** = plain data (typed-array layers + entities + clock + seeded RNG).
- **Systems** run once per tick and talk *only through the data layers*, never to each other.
- The sim is **headless** — it steps without drawing; the renderer reads world state but never drives the sim.
- Five swappable **seams** (`IFireModel`, `IFuelModel`, `IWeatherProvider`, `ISuppressionAgent`, `IRenderer`) abstract at the system/model boundary, never per-cell.

## Roadmap (see handoff §6)

Phase 1 (this scaffold) — core CA spread + all seams stubbed. → Phase 2 science
anchor (Anderson 13 + Rothermel) → Phase 3 dynamic world → Phase 4 firefighting
→ Phase 5 polish. Structures/WUI and industrial fires are additive later phases.

## License

Boyko Non-Commercial License v1.0 (BNCL-1.0) — non-commercial use only; see
[`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE). Commercial licenses are
available separately from the copyright holder.
