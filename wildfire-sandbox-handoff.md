# Wildfire & Firefighting Sandbox — Development Handoff

**Status:** Design phase complete. Ready to begin Phase 1 implementation in Claude Code.
**Document purpose:** Captures the design decisions, architecture, and roadmap agreed during planning so development can continue without re-litigating settled questions. Read the *Key Decisions* section before changing direction on any of them — each was reasoned through deliberately.

---

## 1. What we're building

A 2D, top-down, interactive **wildfire and firefighting sandbox**. The user can generate/edit terrain, set one or more ignition points and conditions, watch fire spread and evolve, and fight it with a range of resources (ground crews using different methods, aerial firefighting). The world is dynamic — wind shifts, rainfall, changing conditions over time.

The player's role is essentially that of an **incident commander**: top-down is the natural and intended view for the tactical decisions this sim is about.

### What it is
- A **sandbox** — open-ended experimentation, not a scenario-on-rails game.
- **Science-grounded** — built on real operational fire-spread models, standard fuel models, and realistic firefighting doctrine.

### What it is explicitly NOT
- **Not a research or predictive tool.** There is a real gap between *science-grounded* (real equations, real fuel models, plausible and instructive behavior) and *validated/predictive* (calibrated against real fire data, trustworthy for real decisions). We are building the former. Do not oversell it as the latter — that's a genuine research problem agencies spend careers on. The sandbox should *feel* authentic and *teach true things*; it should not claim to predict a real burn.

---

## 2. Key decisions (with rationale — do not silently reverse)

These were worked through deliberately. The rationale matters because it's what stops a future session from reopening them.

### 2.1 Simulation is 2.5D, not full 3D
The simulation computes over a **heightfield** (a 2D grid where elevation is an attribute) with **stacked layers**, not a 3D volume.

- This **is** the operational science. The serious models — Rothermel, FARSITE, FlamMap, BEHAVE — are all surface models over a heightfield. Fire spreads across a surface; slope and aspect matter (fire runs uphill) but the domain is 2.5D.
- Going volumetric does **not** increase realism for our purposes — it shifts the project into CFD (FIRETEC, WFDS, FDS), which runs on clusters, takes hours/days for small domains, and answers a *different question* (what happens inside one plume over minutes) than a sandbox asks (how fire spreads across a landscape over hours). That's the research-tool territory we are avoiding.
- Vertical phenomena that matter are captured without a volume:
  - **Crown fire** = two coupled surface layers (surface fuel + canopy) with a transition threshold (when surface fireline intensity exceeds a criterion, crowning occurs). Vertical fire structure from stacked 2D, not 3D.
  - **Plume rise / spotting** = modeled phenomenologically (launch embers as a function of intensity and wind, with a lofting distribution). Model the *consequence* of the updraft, not the updraft.

### 2.2 Rendering is 2D top-down. No 3D visualization.
Decided and settled — the user does not want 3D visualization. Top-down serves the incident-commander role best (tactical overlays — fire perimeter, containment lines, unit positions, triage markers — read far better top-down) and keeps dev/verification fast. 3D rendering is a classic scope-creep trap (weeks on camera, LOD, particles before the fire model exists).
- Optional cheap polish that's allowed: hillshading or contour relief for terrain legibility, plus stylized smoke/flame. No perspective camera.
- Because the sim is decoupled from rendering (see architecture), a renderer is *just a swappable seam*. A 3D view could be added later as a pure visualization upgrade touching nothing in the sim — but it is not planned.

### 2.3 Interior / compartment fire is OUT OF SCOPE (separate project)
Building-*interior* firefighting is a genuinely different problem class and must not bleed into this engine.
- Wildland fire = a **spread problem over a spatial domain** (where does the front go; fuel continuity, slope, wind).
- Interior fire = a **state problem in an enclosure** (heat/smoke accumulate in a confined volume; phases: growth → flashover → ventilation-limited burning). Master variable is **ventilation**, which has no analog in open landscape. It's genuinely 3D and topological (smoke stratifies; fire moves through a connectivity graph of rooms/doors/stairwells/HVAC, not a continuous grid). Time/space scales differ (seconds–minutes in one structure vs hours across a landscape). Tooling is a different lineage (zone models like CFAST, or CFD/FDS) with no clean Rothermel-equivalent shortcut.
- **The seam is honored, not the implementation:** in this sim a building is a coarse `IgnitableEntity` (a cell-scale object in a bigger spread problem). A future interior project would treat that same building as an *entire spatial domain* — "zoom into this structure" becomes its own room-graph sim. The two meet at a clean interface (an entity's state vs that entity's internal world). Loose coupling makes this a future plug-in, not present scope.

### 2.4 Loose coupling is a first-class requirement
Components must be interchangeable and upgradeable. The architecture in Section 3 exists to serve this. Get the seams right from day one; retrofitting them is painful.

---

## 3. Architecture

### 3.1 Core pattern: world state + systems
- A shared **world state** = plain data: the layer arrays, the agents/entities, the simulation clock. No behavior.
- A set of **systems**, each running once per tick, each reading/writing only its slice of world state.
- **Critical discipline:** systems communicate *through the data layers, never by calling each other.* The weather system writes a wind field into world state; the fire system reads it and has no idea how it got there. This is what makes pieces swappable — replace uniform wind with spatially-varying or imported real wind and the fire model never changes.

### 3.2 Non-negotiable foundations
- **Headless sim, separate from rendering.** The sim must step without drawing. This is what makes it testable and lets Claude Code verify each system in isolation. Rendering reads world state; it never drives the sim.
- **Seeded RNG.** All stochastic behavior flows through a seeded generator so scenarios are reproducible.

### 3.3 Swappable interfaces (the seams)
Abstract at the **system/model boundary, not the per-cell boundary.** Per-cell virtual calls will kill performance. The seam is e.g. `IFireModel.step(world, dt)`; *inside* that method, rip through typed arrays tightly. Swap whole models, not individual cell behaviors.

- `IFireModel` — fire spread. Phase 1: CA. Later: CA driven by Rothermel-derived rates.
- `IFuelModel` — "given a fuel-type id, return spread parameters." Start Anderson 13; swap to Scott & Burgan 40 without touching spread logic.
- `IWeatherProvider` — supplies wind field, moisture drivers, events. Start uniform/scripted; later spatially-varying or data-driven.
- `ISuppressionAgent` — a firefighting capability (crew, engine, aircraft, agent type). New capabilities = new implementations.
- `IRenderer` — reads world state, draws. 2D top-down now; swappable later.

### 3.4 The unifying entity abstraction
A **WUI structure and an industrial vessel are the same abstraction**: an `IgnitableEntity` — material properties + ignition/burn state machine + suppression effectiveness keyed to agent type. Build this one entity model cleanly and both structures and industrial hazards fall out of it. Stub it in Phase 1 (empty but present) so later phases are additive, not surgery.

### 3.5 Tech stack
- **HTML5 Canvas + TypeScript.** Path of least resistance for a 2D top-down interactive sandbox.
- **Typed arrays** for layers — one `Uint8Array` (or appropriate typed array) per layer. Comfortably handles hundreds of thousands of cells at 60fps.
- WebGL / compute shaders only if scaling to very large maps later. Not now.

---

## 4. Domain model details

### 4.1 Terrain — stacked layers, not one
- **Elevation** (heightfield) — drives slope/aspect. Generate with Perlin/simplex noise.
- **Fuel type** — what burns; includes nonburnable cells (rock, water, roads). Maps via `IFuelModel`.
- **Moisture** — modulated by weather (drying/wetting).
- **Canopy** — for crown-fire coupling (see 2.1).
- **Editor** = paint tools over these layers. Flat canvas painting (one reason 2D rendering stays simple).

### 4.2 Fire spread
- Phase 1: **cellular automaton** — unburned / burning / burned, spread to neighbors with probability modulated by wind, slope, fuel.
- Phase 2+: **hybrid** — CA where each cell's spread *timing/rate* comes from **Rothermel** surface-spread equations (rate of spread, fireline intensity, flame length) fed by **standard fuel models**. This is the science anchor and the realism sweet spot. (Full FARSITE-style Huygens wavefront propagation at a later stage)
- Crown fire and spotting per 2.1.

### 4.3 Weather & events
- **Wind (speed + direction)** dominates everything; time-varying wind is the most dramatic event (a shift flips which flank is dangerous).
- **Rain / humidity** feed a simple fuel-moisture drying/wetting model.
- **Spotting** — embers launched ahead of the front start new ignitions; the piece that makes real fires unpredictable. Moderately complex; high payoff.

### 4.4 Firefighting (realistic doctrine)
Lean into real doctrine — suppression is mostly *indirect* attack, anchor points, and containment line, **not** the Hollywood image of dumping water on flames. Modeling that aerial drops are nearly useless against high-intensity crown fire is a constraint that teaches something true.
- **Ground crews:** build containment line (remove fuel from cells), direct attack, backburning.
- **Engines:** finite water.
- **Aerial:** water drops; **retardant that *pre-treats* fuel ahead of the front** for a duration (does not extinguish flames directly).
- **Logistics:** travel/access time, reload cycles, fatigue.

---

## 5. Future features (architecture already supports them)

### 5.1 Structures / wildland-urban interface (WUI)
Arguably the most *relevant* addition — WUI is where most real-world damage and hard decisions happen.
- **As fuel-at-risk:** `IgnitableEntity` with state machine (intact → ignited → burning → destroyed); catches from radiant heat or (most importantly) **embers from the spotting mechanic**; once burning, ignites neighbors. Structure-to-structure spread is its own distance-based model (`StructureFireModel`) running alongside the wildland model — both read the same world and can ignite each other across the interface. Drives urban conflagration.
- **As terrain:** buildings block/redirect; roads act as firebreaks and access routes; structures are **defensible** → triage-and-defend gameplay.

### 5.2 Industrial / chemical fires
Slots into the architecture rather than fighting it. Two key additions:
- **Fuel classes + agent-effectiveness matrix** (agent × fuel class → effect): water good on ordinary combustibles (Class A), spreads flammable-liquid fires (Class B → needs foam), reacts violently with burning metals (Class D → needs dry powder). Adding foam = a new `ISuppressionAgent` + a row in the table.
- **Dramatic event mechanics:**
  - **BLEVE** — a pressurized vessel modeled as an entity that accumulates heat from nearby fire and explodes past a threshold *unless cooled*. Cooling buys time — a real, teachable choice.
  - **Toxic plume** — a new field layer that *advects with the existing wind field*, driving downwind evacuation zones.
- **Honest scope limit:** unlike wildfire's clean standardized fuel models, industrial fire behavior is wildly substance-specific with no tidy catalog. Model a **handful of representative classes** (liquid pool fire, pressurized gas vessel, reactive metal, ordinary combustible) — not a chemistry engine. Still teaches the real lessons: right agent, cool the tank, watch the plume.

### 5.3 Optional real-data import (for later realism)
The data exists if importing real landscapes is ever wanted:
- **LANDFIRE** — fuel and canopy layers.
- **USGS DEMs** — elevation.
- **NFDRS-style indices** — fuel moisture.
This is consistent with "science-grounded sandbox," still not "validated predictor."

---

## 6. Phased roadmap

Each phase should be runnable and verifiable before moving on. The headless sim makes per-system verification possible.

**Phase 1 — Core spread + seams**
Grid + render loop + CA spread (wind/slope/fuel), single ignition, noise terrain. **Stub all the seams now:** world-state/systems split, the five interfaces, and an empty `IgnitableEntity` type. The extension points must exist from day one so later phases are additive.

**Phase 2 — Science anchor**
Anderson 13 fuel models + Rothermel-based spread rates + moisture layer + the terrain editor (paint tools).

**Phase 3 — Dynamic world**
Time-varying wind, rain, spotting.

**Phase 4 — Firefighting**
Ground crews/lines first, then engines, then aerial. Realistic doctrine.

**Phase 5 — Polish**
UI, scenarios, stats overlays, save/load (seeded RNG makes scenarios reproducible).

**Future phases (additive, post-core):** Structures/WUI → Industrial/chemical. (Interior fire = separate project entirely.)

---

## 7. Quick-start guidance for the next session

1. Start Phase 1. Establish the **world state + systems** structure and the **headless/render split** before writing any fire logic — these are the foundations everything else hangs off.
2. Wire the **seeded RNG** in from the first commit.
3. Define the five interfaces (`IFireModel`, `IFuelModel`, `IWeatherProvider`, `ISuppressionAgent`, `IRenderer`) and the empty `IgnitableEntity` as stubs immediately, even though Phase 1 only fills in a CA `IFireModel` and a basic `IRenderer`.
4. Keep fire-model abstraction at the `step(world, dt)` boundary; tight typed-array loops inside.
5. When in doubt on realism scope, re-read Section 1 ("what it is NOT") and Section 2.1 — the answer is almost always "science-grounded sandbox, not CFD, not predictive."
