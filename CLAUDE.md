# Wildfire & Firefighting Sandbox — working notes for Claude

A 2D top-down, **science-grounded** wildfire/firefighting sandbox in TypeScript +
HTML5 Canvas. The player is an incident commander. This is a sandbox, **not** a
validated/predictive tool — see the "Scope guardrails" below.

**Read [`wildfire-sandbox-handoff.md`](./wildfire-sandbox-handoff.md) before
changing direction on any architecture or scope decision.** Each decision there
was reasoned deliberately; don't silently reverse one. Planning docs for
in-flight features go in [`docs/plans/`](./docs/plans/).

## Commands

```bash
npm run dev        # Vite dev server — interactive sandbox
npm test           # Vitest, headless (npm run test:watch for watch mode)
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck + vite build
npm run frame      # headless: run the real sim, write frame.png (smoke check)
```

`tests/determinism.test.ts` runs the real terrain+CA pipeline and asserts a seed
reproduces a run byte-for-byte — that is what backs the "seeded RNG everywhere"
invariant below. Don't introduce `Math.random()`; it would break that test.

Each commit should typecheck and pass tests. Conventional Commits style.

## Architecture invariants (do not break these)

- **World state = plain data, no behavior** (`src/core/world.ts`): typed-array
  layers + entities + clock + seeded RNG.
- **Systems** (`src/core/system.ts`) run once per tick via `step(world, dt)` and
  read/write only their slice. **Systems never call each other** — they
  communicate through the data layers. (Replacing one model must not touch
  another.)
- **Headless sim / render split** (`src/core/simulation.ts`): the sim steps
  without drawing. The renderer reads world state; it never drives the sim.
- **Seeded RNG everywhere** (`src/core/rng.ts`): all randomness flows through
  `world.rng` so a seed reproduces a run byte-for-byte. Don't call `Math.random()`.
- **Abstract at the system/model boundary, never per-cell.** The seam is
  `IFireModel.step(world, dt)`; *inside* it, loop over typed arrays tightly. No
  per-cell virtual calls (they kill performance).

## The five seams (`src/models/`) + entity

`IFireModel`, `IFuelModel`, `IWeatherProvider`, `ISuppressionAgent`, `IRenderer`,
and the unifying `IgnitableEntity`. All exist as stubs from Phase 1 so later
phases are additive. Phase 1 implementations live in `src/sim/` (`CaFireModel`,
`BasicFuelModel`, `UniformWeatherProvider`) and `src/render/`.

## Layout

```
src/core/    world state, layers, rng, clock, system, simulation (the foundation)
src/models/  the five swappable seam interfaces + IgnitableEntity
src/sim/     seam implementations: P1 CA fire/basic fuel/uniform weather; P2 rothermel + anderson13
src/gen/     terrain generation (seeded value noise)
src/render/  canvas renderer
src/main.ts  browser entry: wires world + systems + renderer, runs the loop
tests/       headless tests — simulation.test.ts is the architecture proof
```

## Scope guardrails (from handoff §1, §2.1)

When unsure on realism: **science-grounded sandbox, not CFD, not predictive.**
- Simulation is **2.5D** (heightfield + stacked layers), not a 3D volume.
- Rendering is **2D top-down only** — no perspective camera, no 3D viz.
- **Interior/compartment fire is a separate project** — keep it out of this engine.
- Don't oversell behavior as validated prediction; it should *feel authentic and
  teach true things*, not claim to predict a real burn.

## Roadmap (handoff §6)

P1 core CA + seams (done) → P2 Anderson 13 + Rothermel + moisture + editor →
P3 dynamic wind/rain/spotting → P4 firefighting doctrine → P5 polish.
Each phase must be runnable and verifiable before the next.
