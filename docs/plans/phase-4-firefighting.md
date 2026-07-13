# Phase 4 — Firefighting (realistic doctrine)

> **Status: PLANNED.** Phase 3 (dynamic world) is complete. This is the plan for
> the roadmap's next phase (handoff §6): player-commanded suppression that leans
> into **real doctrine** — indirect attack, anchor points, and containment line,
> **not** the Hollywood image of dumping water on flames.

**Goal (roadmap §6 "P4 firefighting doctrine"; handoff §4.4):** put the player in
the incident-commander seat with suppression tools that *teach true things*.
Suppression is mostly **indirect** — you deny the front fuel and pre-treat ahead
of it; you don't extinguish your way out. Modeling that aerial drops are nearly
useless against high-intensity crown fire is a constraint that teaches something
true (§4.4).

Built in the roadmap's order: **ground crews/lines → engines → aerial.** Like
Phase 3, this is one plan spanning three slices (4a detailed, 4b/4c sketched);
each slice must be runnable and verifiable before the next.

---

## The load-bearing design decision: Phase 4 is *layer-only*, like spotting

The tempting worry is "how does suppression reach the fire model's private
`progress` accumulator to put a fire out?" **It doesn't, and it must not.**

Promoting `RothermelFireModel`'s private `progress` to a shared world layer would
leak **one fire model's discretization** into state every model and system is then
expected to honor. `IFireModel` deliberately does not expose it; the Phase-1
`CaFireModel`'s notion of arrival state isn't even the same shape. That is a seam
violation in spirit — the opposite of the swappability invariant (handoff §3.1).
The **fuel** and **moisture** layers, by contrast, are read by *any* fire model
(both flow through the fuel bed), so suppression that writes them works whatever
fire model is mounted.

The discriminating check for the entire phase:

> **Does any §4.4 mechanic require turning a cell that is already Burning/Burned
> back toward Unburned?**

Walk the list — containment line, direct attack, backburn, engine water, aerial
drop, retardant — and **none do.** Every one operates on *unburned fuel at or
ahead of the front*:

| Mechanic | Layer write | Why the front stops / is denied |
|---|---|---|
| **Containment line** | `fuel` → `CutLine` (nonburnable params) | Fire model hits `!fp.burnable → continue`; the front can't accumulate `progress` on a non-burnable bed (`rothermelFireModel.ts:129`). |
| **Direct attack / engine water** | `moisture` spike at the active edge | Rothermel ROS → 0 at/above extinction moisture; the front stalls. Un-burns nothing. |
| **Backburn** | existing `ignite()` on unburned fuel | Removes fuel ahead of the front by burning it under the player's control. |
| **Aerial water drop** | area `moisture` spike | Same as engine water, over a footprint. |
| **Retardant** | `moisture` (4a/4b) → dedicated `retardant` layer (4c) | Pre-treats unburned fuel ahead of the front for a duration. |

So Phase 4 is **fully additive, exactly like spotting** — no fire-model surgery,
and (for 4a) no new layers. The "hard problem" the editor comment warned about
(`terrainEditor.ts:20-24`) dissolves *into the teaching thesis*: you can't
extinguish your way out (flames burn their Albini residence time regardless, and
`isIgnited` treats **Burned** cells as permanent spread sources —
`rothermelFireModel.ts:187`), so you **deny the front fuel**.

### Two properties this buys for free

- **Water knockdown decays on its own.** `FuelMoistureSystem` already evolves
  moisture toward EMC each tick, so a moisture spike dries back down with no extra
  code. "The wet line held until it dried, then the front crossed" emerges for
  free — and teaches that water alone is temporary.
- **Anchor points emerge.** A line not tied into a nonburnable feature (rock,
  water, road, or another line) simply gets **flanked** — the front rounds the
  line's open end. No special mechanic; it falls out of the geometry, and it's
  exactly the doctrine reason real crews anchor every line.

---

## What the spotting precedent does NOT cover (new for Phase 4)

Spotting is an autonomous system. Suppression adds three things it didn't:

1. **A player command layer.** Crews/engines/aircraft are player-*commanded*,
   unlike weather/moisture/spotting which run themselves. Model the command shell
   **like `TerrainEditor`**: a browser-only DOM+pointer layer wired in `main.ts`
   that turns a click into an *order* (assign unit → target cell + task). It is
   **non-deterministic and lives outside the determinism test**, exactly as the
   editor does. Agent **execution** (moving toward the target, doing work on
   arrival) is deterministic arithmetic inside `step()`; any randomness draws from
   `world.rng` in fixed order (handoff §3.2).

2. **Per-unit state lives on the agent object.** Position, remaining water,
   fatigue, current order, travel progress — private fields on the
   `ISuppressionAgent` instance, precisely as `RothermelFireModel` privately holds
   `progress` and its residence-time cache. A `System` is allowed private state;
   it just must talk to *other* systems only through layers.
   **Do NOT conflate crews with `IgnitableEntity`.** That abstraction is for
   *fuel-at-risk* (structures that don't move and do burn — handoff §5.1). A crew
   is a suppression agent: a separate concept that moves and does not burn.

3. **Pipeline order is load-bearing** (same discipline the spotting doc pins).
   Suppression sits **after moisture, before fire**:
   `weather → moisture → suppression → fire → spotting`.
   Rationale to put in the module header: a water/retardant write must land in the
   `moisture` layer *before* the fire model reads it **this** tick (so a drop
   actually protects the bed the fire evaluates this tick), and a backburn must
   `ignite` in time for the fire model to spread it this tick. Suppression before
   moisture would let the drydown step immediately eat the same-tick drop.

---

## 4a — Ground crews + containment line + backburn (the foundation)

The first exercise of the `ISuppressionAgent` seam, and the phase's spine. Spec
in implementable detail:

### `GroundCrew implements ISuppressionAgent` (`src/sim/groundCrew.ts`)
- `agentType = 'hand-crew'` (the key for the future agent × fuel-class matrix,
  §5.2).
- Private state: `x, y` (cell position), `speed` (cells/sec), a task queue of
  orders, `lineProgress` (partial work on the current cell), and `fatigue`
  (0..1, raises the seconds-per-cell of line as it climbs — logistics, §4.4).
- `step(world, dt)`:
  1. **Travel.** If not yet at the order's cell, advance position toward it at
     `speed` (deterministic; travel/access time is a §4.4 logistics lever). Crews
     move slower through heavy fuel / uphill — a cheap, honest cost multiplier.
  2. **Work on arrival**, by task:
     - **`cut-line`**: accumulate work on the target cell; when it completes, set
       `fuel[i] = Fuel.CutLine`. **Only on `Unburned` cells** (see gotcha below).
     - **`backburn`**: `ignite()` an unburned cell between the line and the front,
       on the player's timing (the classic "fight fire with fire" — remove fuel
       ahead of the main front). No indraft modeling (see out-of-scope).
     - **`direct-attack`**: spike `moisture` on the burning edge cell toward
       saturation (knockdown). Decays via the moisture system — deliberately
       temporary, to teach that hand crews hold the line, they don't extinguish.

### The cut-line fuel id
Add `Fuel.CutLine = 4` to `basicFuelModel.ts`. It resolves to the **nonburnable**
params in *both* `BasicFuelModel`'s and `TerrainFuelModel`'s tables (so every fire
model treats a cut line as a barrier), but is a **distinct id** so the renderer can
draw a **dozer/hand line** (a tan scratch) rather than grey rock. Add one palette
entry in `canvasRenderer`. The fuel layer staying `0..4` keeps the CA path and the
determinism test untouched (the golden uses seed terrain that never paints id 4).

### Two gotchas (both real, both from reading the model)
- **Build line on `Unburned` cells only.** Cutting fuel out from under a *Burning*
  cell sets it to a fuel with residence time 0 → it flashes to `Burned` instantly,
  and `Burned` is a **permanent spread source** (`isIgnited`) — you'd be planting
  fire sources inside your own line. Guard the `cut-line` task on `Unburned`.
- **Lines don't stop embers.** `SpottingSystem` can still loft a brand across a cut
  line (it already jumps nonburnable firebreaks — that's its headline test). This
  is correct and teaches a true thing; note it in the doc, don't "fix" it.

---

## 4b — Engines (finite water, direct attack, reload) — *sketch*

- `Engine implements ISuppressionAgent`, `agentType = 'engine'`. Same
  travel/work substrate as the crew, plus a **finite `waterLiters`** resource.
- **Direct attack** = a stronger, wider `moisture` knockdown than a hand crew, but
  it **draws down water** per second of application. When empty, the engine must
  **travel to a water source** (a `fuel`/terrain feature, or a static refill point)
  and **reload** over time — a reload cycle (§4.4 logistics). Fatigue optional.
- Teaching beat: even with water, an engine only *holds* an edge; the durable
  containment is still the line the crew cut. Reinforces 4a.

## 4c — Aerial (drops + retardant, the crown-fire lesson) — *sketch*

- `Aircraft implements ISuppressionAgent`, `agentType = 'air-tanker'` /
  `'helicopter'`. Long travel legs, big reload cycles (return to base/dip site).
- **Water drop** = a large area `moisture` spike (same mechanism as engine water,
  bigger footprint, short-lived after drydown).
- **Retardant = the one genuine new-layer question.** It is chemical, so it must
  persist **longer** than water and **resist the EMC drydown** that
  `FuelMoistureSystem` applies to the moisture layer. One moisture layer with one
  decay law can't give some cells a slow decay. So retardant likely wants a
  **dedicated `retardant` layer** (a persistent ROS-suppressor the fire model
  reads, decaying on its own slow schedule), pre-treating **unburned fuel ahead of
  the front** for a duration — it does **not** extinguish flames directly (§4.4).
  **This layer decision is deferred to 4c**; 4a and 4b need zero new layers.
- **The crown-fire constraint (§4.4).** Effectiveness must fall off sharply with
  fireline intensity / canopy — a drop on a high-intensity timber crown fire is
  **nearly useless**. This is the phase's signature teaching moment; wire it as an
  intensity/canopy-gated cap on the moisture/retardant effect, and pin it with a
  test.

---

## Architecture fit (additive — nothing prior is rewritten)

- Each unit is a separate `System` implementing `ISuppressionAgent`, reading and
  writing **only layers** (`fuel`, `moisture`, `fire` via `ignite`) — never
  calling another system (handoff §3.1). The private `progress` of the fire model
  is **never touched** (see the design decision above).
- Ordered `weather → moisture → suppression → fire → spotting` (load-bearing;
  documented in each agent's header).
- Wired **only in `main.ts` and `tools/renderFrame.ts`**, exactly like spotting —
  the headless `Simulation`, the seams, and the **determinism golden** (CA
  pipeline, no suppression) are untouched. No golden regen.
- Determinism preserved: agent execution is deterministic arithmetic; any random
  draws go through `world.rng` in a fixed order. The *player command* layer is
  non-deterministic and outside the determinism test (like the editor).

---

## Verification (headless; mirror the spotting tests)

- **`tests/suppression.test.ts`:**
  - **Line stops the front** *(4a acceptance gate)*: a `CutLine` band painted
    across a burnable field, spotting off — the front reaches the line and stops;
    the far side stays cold. (Directly parallels the spotting firebreak test,
    inverted: here the barrier must *hold*.)
  - **Wet band stalls then crosses**: a `moisture` band above extinction stops the
    front while wet; after the moisture system dries it below extinction, the front
    crosses. Pins the "water is temporary" property.
  - **Logistics — travel time gates work**: a crew ordered to a distant cell cannot
    complete line there before its travel time has elapsed.
  - **The doctrine-pinning test** *(encodes §4.4)*: **direct attack on the flaming
    edge alone does not stop spread; a cut line does.** Run identical scenarios —
    one knocking down the burning edge each tick, one cutting a line ahead — and
    assert only the line contains the fire. This turns the thesis into a test, in
    the project's "teach true things" spirit.
  - **Anchor point**: a line that does not reach a map-edge/nonburnable feature is
    flanked (front cells appear past the line's open end); a fully anchored line is
    not. (Optional but high-value.)
- **`GroundCrew` unit tests**: travel reaches the target in the expected ticks;
  `cut-line` writes `CutLine` only on `Unburned`; backburn ignites an unburned
  cell.
- Determinism golden unchanged; full suite green; `npm run frame` renders a scene
  with a line drawn.

---

## Out of scope (keeps us honest against §2.1)

- **Fire-induced indraft** pulling a backfire toward the main front is
  CFD-adjacent (against handoff §2.1). A backfire simply spreads per ambient
  wind/slope; the **player** times and places it. Model the consequence, not the
  coupled flow.
- **`IgnitableEntity` structures / WUI triage.** Defending structures from embers
  is handoff §5.1 (a *future* phase after the core roadmap), not Phase 4. Crews are
  suppression agents, not entities.
- **Agent × fuel-class effectiveness matrix** beyond the single `agentType` key
  (foam/Class-B, dry powder/Class-D) is §5.2 industrial scope.
- **Pathfinding / obstacle avoidance** for travel — straight-line travel with a
  fuel/slope cost multiplier is enough for the sandbox; A* is polish, not doctrine.

---

## Slice order & exit criteria

1. **4a** — agent/travel/logistics substrate + containment line + backburn +
   `Fuel.CutLine` + the line/doctrine tests. **Exit:** the line-stops-the-front
   gate and the doctrine-pinning test pass; a line is drawable and holds in the
   browser demo.
2. **4b** — engines: finite water, water-drawing direct attack, reload cycle.
   **Exit:** an engine holds an edge, runs dry, reloads, resumes.
3. **4c** — aerial: drops + the `retardant` layer decision + the crown-fire
   effectiveness falloff, pinned by a test. **Exit:** retardant persists past a
   water drop's drydown; a drop on a high-intensity crown fire is shown near-useless.

With 4a–4c landed, **Phase 4 is complete**; next up the roadmap is **Phase 5 —
polish** (UI, scenarios, stats overlays, save/load), then the additive future
phases (Structures/WUI → Industrial).
