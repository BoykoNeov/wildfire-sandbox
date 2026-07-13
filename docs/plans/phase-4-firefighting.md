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
     - **`direct-attack`**: spike `moisture` toward saturation on the **unburned**
       fuel in a small footprint at the active edge (knockdown). *Unburned*, not the
       burning cell: the Rothermel model reads moisture only at the destination cell
       the front spreads *into* (`rothermelFireModel.ts:144`), so a spike on a
       burning cell is a literal no-op. A point crew's small wet patch is flanked by a
       wide front; it decays via the moisture system once the crew leaves —
       deliberately temporary, to teach that hand crews *hold* the line, they don't
       extinguish. (Prose corrected during 4a build; the mechanism row below was
       always right.)

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

## 4b — Engines (finite water, direct attack, reload) — **✅ DONE (2026-07-13)**

- `Engine implements ISuppressionAgent`, `agentType = 'engine'` (`src/sim/engine.ts`).
  Shares the crew's travel/work substrate — extracted to **`src/sim/suppressionTravel.ts`**
  (pure `advanceToward` + `effectiveSpeed` taking a per-agent `TravelParams`
  {speed, resistance table, slope penalty}; the crew was refactored onto it, 4a
  tests still green) — plus a **finite water tank**. The engine is road-biased:
  higher off-road fuel/slope resistance than the crew on foot.
- **Direct attack** = a wider (5×5 vs 3×3) and wetter (0.9 vs 0.6) `moisture`
  knockdown than a hand crew, but it **draws the tank down** per second of
  application. "Stronger" is **coverage + persistence**, NOT a harder instantaneous
  hit — the crew's 0.6 already zeros ROS on contact (above every Anderson
  extinction moisture); the higher saturation just dries back toward EMC more slowly
  so the engine's line holds longer after it leaves.
- **Reload cycle (§4.4 logistics):** when the tank hits 0 with work still queued,
  the engine breaks off, drives to a **static configurable refill point** (default
  = spawn cell; no water-terrain detection — `Nonburnable` is ambiguously rock *or*
  water), tops up over `refillSeconds`, and **resumes the same held station**
  automatically (the direct-attack order is sticky, so it stays at the queue head).
  No fatigue: an engine is water-limited, not muscle-limited.
- **Determinism:** pure arithmetic, **no `world.rng` draw** — load-bearing because
  the engine steps *before* `SpottingSystem` (the only rng consumer); a draw would
  desync spotting and the CA-only golden would not catch it.
- Teaching beat: even with water, an engine only *holds* an edge (its finite
  footprint is flanked); the durable containment is still the line the crew cut.
  Reinforces 4a.
- Wired in `main.ts` (systems band `weather → moisture → crew → engine → fire →
  spotting`; an "Engine attack" tool + water gauge added to the command shell) and
  `tools/renderFrame.ts`. Tests: **`tests/engine.test.ts`** (5) — footprint+drawdown,
  no-draw-while-travelling, order-replacement, the **four-verb reload cycle**
  (holds → runs dry → drives to water → reloads → resumes the same station, pinned
  by a state-sequence scan), and a **live-Rothermel doctrine test** (parity with 4a:
  the station stays `Unburned` while the tank has water, yet the front flanks past
  the finite footprint). Full suite green; determinism golden untouched.

## 4c — Aerial (drops + retardant, the crown-fire lesson) — **✅ DONE (2026-07-13)**

- `Aircraft implements ISuppressionAgent`, `agentType = 'air-tanker'` (`src/sim/aircraft.ts`).
  Flies the shared `suppressionTravel` substrate with resistance 1 everywhere (terrain-
  independent) and makes discrete **sorties**: fly out → lay one drop over a wide (7×7)
  footprint → return to base → reload (a long §4.4 turnaround) → ready. One drop per pass.
- **Water drop** = a large `moisture` spike on unburned fuel (engine mechanism, bigger
  footprint), temporary — it rides the shared slow drydown.
- **The retardant layer decision (resolved — a deliberate divergence from the sketch's
  "fire model reads it" option B).** Retardant needs its **own** decay law: one moisture
  layer with one drydown can't also give some cells a *slower* decay, so a **dedicated
  `retardant` layer** was added (`world.ts`). But rather than have the fire model read it
  (spread-math surgery on the mounted model — the thing the whole phase avoids),
  **`RetardantSystem`** (`src/sim/retardantSystem.ts`, a plain System, not a seam) owns
  the layer: each tick it decays every treated cell on retardant's own slow schedule
  (default 4 h) and **re-pins `moisture`** from it (pin ∝ potency), in the suppression
  band after the aircraft + moisture, before fire. The fire model is **never told about
  retardant** — it still reads only `moisture` — so the layer-only spine holds, and
  spotting's moisture-gated landing check makes retardant lines resist embers for free.
  Retardant is honestly "water that lasts": same ROS effect while active, distinguished
  by **persistence**. The layer stays all-zero without a drop, so the determinism golden
  (which compares only `fire`+`elevation`) is untouched.
- **The crown-fire constraint (§4.4) — gated on canopy × *flaming activity*, not canopy
  alone.** `crownFalloffEffectiveness(localCrown)` where `localCrown` = the canopy
  fraction of the most intense **actively flaming** cell in the drop cell's 3×3. A drop
  on unburned timber *well ahead* of the front (no flaming neighbour) lands full strength
  (that indirect pre-treatment is the doctrine); a drop on a flaming timber crown
  (canopy 0.78 → effectiveness ≈ 0.14 → deposit 0.9·0.14 ≈ 0.13, **below** timber's 0.25
  extinction moisture) is near-useless. Gating on canopy alone was rejected (advisor):
  it would make pre-treating unburned timber ahead read as useless too, teaching the
  wrong thing. Falloff scales the deposited potency, so it carries through the moisture
  re-pin. Applied at the aircraft (layer-only) — the fire model is not involved.
- Wired `main.ts` + `renderFrame.ts` (band `weather → moisture → crew → engine →
  aircraft → retardant → fire → spotting`), a rust-red slurry tint in the palette
  (alpha ∝ potency, so a line fades as it decays), and Water/Retardant drop tools +
  an air-tanker marker in the command shell (typechecked/built, not driven
  interactively — same caveat as 4a/4b). `npm run frame` draws a slurry square.
- Tests: **`tests/aircraft.test.ts`** (9) — the pure falloff (full ahead / near-useless
  on a flaming crown, its deposit below extinction / grass fire still suppressible), a
  **live-Rothermel behavioural falloff** (a full band *ahead* halts the front; a drop
  *on the flaming crown* barely dents it vs a no-drop control), the sortie + reload
  cycle (fly → drop once → RTB → reload → ready; a second sortie waits for reload), a
  layer-only guard (the drop never touches `fire`), and the **retardant-outlasts-water**
  persistence (after ~100 min the water cell has dried below extinction while retardant
  holds above it; once the timer expires the cell is released and dries). Full suite 146
  green; determinism golden untouched.

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
   browser demo. **✅ DONE.** `src/sim/groundCrew.ts` (`GroundCrew`,
   `agentType='hand-crew'`), `Fuel.CutLine=4` (nonburnable in both fuel tables) with
   a tan palette entry, the browser command shell `src/editor/suppressionCommand.ts`
   (wired in `main.ts`, ordered weather→moisture→suppression→fire→spotting), and
   `tests/suppression.test.ts` + `tests/groundCrew.test.ts` (all five §Verification
   gates: line-stops-front, wet-band stalls-then-crosses, logistics, doctrine-pinning,
   anchor point). Determinism golden untouched; `npm run frame` draws a line (the
   *mechanic* — line holds, wet patch is flanked — is proven headlessly by the tests;
   the browser command shell is typechecked + built but its click→order path has not
   been driven interactively).
2. **4b** — engines: finite water, water-drawing direct attack, reload cycle.
   **Exit:** an engine holds an edge, runs dry, reloads, resumes. **✅ DONE.**
   `src/sim/engine.ts` (`Engine`, `agentType='engine'`) on the shared
   `src/sim/suppressionTravel.ts` substrate; wired in `main.ts` + `renderFrame.ts`;
   `tests/engine.test.ts` pins the four-verb reload cycle. The command shell's
   "Engine attack" tool + water gauge are typechecked + built but, like 4a's shell,
   not driven interactively.
3. **4c** — aerial: drops + the `retardant` layer decision + the crown-fire
   effectiveness falloff, pinned by a test. **Exit:** retardant persists past a
   water drop's drydown; a drop on a high-intensity crown fire is shown near-useless.
   **✅ DONE.** `src/sim/aircraft.ts` (`Aircraft`, `agentType='air-tanker'`) +
   `src/sim/retardantSystem.ts` (dedicated `retardant` layer, re-pins `moisture`, fire
   model untouched) + the canopy×flaming-activity falloff; `tests/aircraft.test.ts`
   pins both exit criteria. Wired in `main.ts` + `renderFrame.ts`; slurry palette tint;
   command-shell drop tools (not driven interactively, same caveat as 4a/4b).

With 4a–4c landed, **Phase 4 is complete**; next up the roadmap is **Phase 5 —
polish** (UI, scenarios, stats overlays, save/load), then the additive future
phases (Structures/WUI → Industrial).
