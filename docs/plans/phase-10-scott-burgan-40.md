# Phase 10 — the Scott & Burgan 40 fuel catalogue

**Status:** done.
**Closes:** `docs/science.md` §9, "A fuel catalogue the herbaceous load transfer
can bite on."

## Why

Phase 9b built BehavePlus's dynamic herbaceous **load transfer** — cured live
grass becomes dead fuel — and then measured it into near-irrelevance, because the
Anderson 13 give it exactly one model to act on (FM2, 0.023 lb/ft² of live
herbaceous against 0.161 of dead) and BehavePlus itself gates the mechanic behind
an `isDynamic` flag that all thirteen fail. §3c ends by naming the catalogue where
it *should* bite: Scott & Burgan (2005) RMRS-GTR-153, whose grass and grass–shrub
models carry most of their load as live herbaceous and are dynamic by design.

That catalogue is the missing half of a mechanic that already ships. It is also
the biggest single widening of the sandbox's fuel vocabulary available: 13 → 53
models, with real distinctions (dry-climate vs humid-climate grass, four
grass–shrub bands, nine shrub models, five timber–understory, nine litter, four
slash/blowdown) that the Anderson 13 collapse.

## Scope

**In.** The 40 standard Scott & Burgan models as data; a fuel model serving the
union of both catalogues; per-model gating of the herbaceous transfer on each
model's own `dynamic` flag; the season pair remapped onto dynamic grass models
and re-measured; tests; `docs/science.md`.

**Out.** No Rothermel maths changes. No new system, no new layer, no new
encoding. The fuel *layer* stays the generic 0–4 terrain classes, so the palette,
the editor, the Phase-1 CA path and the determinism golden are all untouched — a
catalogue is a lookup behind `IFuelModel.getParams`, which is precisely the seam
this was built for. The five custom/regional families BehavePlus also ships
(`SCAL*`, `V-*`, `M-*`, the `NB*` non-burnables) are **not** transcribed: they are
not the standard 40, and two of them carry *different dead and live heat
contents*, which our single-`heatContent` fuel bed cannot represent.

## Decisions

### D1 — Model numbers are the published ones (101–204), in one union map

Scott & Burgan number their models 101–109 (GR), 121–124 (GS), 141–149 (SH),
161–165 (TU), 181–189 (TL), 201–204 (SB). Those do not collide with Anderson's
1–13, they fit a byte, and they are what every other tool and every LANDFIRE
raster uses. So: keep the published numbers, and serve both catalogues from one
`StandardFuelModel` over a union map. `Anderson13FuelModel` stays exactly as it
is so that every existing test keeps its subject unchanged.

### D2 — Loads keep their tons/acre literals, `f` applied in code

BehavePlus writes these rows as `0.10*f` with `double f = 2000.0/43560.0`,
because the published tables are in **tons/acre** while Rothermel wants lb/ft².
The Anderson rows in `anderson13.ts` are transcribed already-converted because
that is how `fuelModels.cpp` writes *them*. Here the source keeps the conversion
visible, so we do too: a row must cross-check against the C++ line by line, and
`0.10 * TONS_PER_ACRE_TO_LB_PER_FT2` does that where `0.00459` does not.

### D3 — `dynamic` is a flag on the fuel, and it gates the transfer

`RothermelFuel` gains `dynamic?: boolean`. It is a catalogue *convention* on an
interface otherwise made of physical descriptors, which is a mild altitude smell
— but the fire model holds only the `RothermelFuel` at the point where it must
decide, and the alternative (a second lookup keyed by fuel id) is worse. All 13
Anderson models set it false; 17 of the 40 set it true (GR1–GR9, GS1–GS4, SH1,
SH9, TU1, TU3).

### D4 — `dynamicHerbLoad` becomes three-state

| value | meaning |
|---|---|
| omitted (default) | follow each model's own `dynamic` flag — what BehavePlus does |
| `true` | force the transfer on for every model — the Phase-9b extension of the Anderson catalogue, preserved |
| `false` | force it off even for dynamic models — for isolating the moisture half from the load half |

The default is byte-identical to today for every Anderson bed, because all 13 are
static. The footgun is that `false` stops meaning "same as omitted"; that is the
price of keeping the 9b escape hatch, and it is documented at the option.

### D5 — One resolver, so a fuel has one dead bed

The transfer feeds two places in `rothermelFireModel.ts`: the cached surface bed
(`surfaceBedFor`) and the flame-residence characteristic SAV (`bedSAV`). Phase 9b
put the transfer in `deadFuelBed` precisely so those two agree. So the per-model
gate resolves in **one** private method returning the `BedOptions` for a fuel, and
both call sites use it. Two option objects are pre-built at construction (one with
the transfer, one without) so the gate costs a branch, not an allocation.

Two notes that look like bugs and are not:

- **The bed cache needs no new dimension.** Its key is `fuelId * 256 +
  moistureByte`, and the gate is a pure function of `fuelId`.
- **The crown proxy is unaffected.** `crownBedFor` runs FM10 as Rothermel's 1991
  stand-in for crown fuel; FM10 has `liveHerbLoad: 0`, so the transfer is a no-op
  there whichever way the gate falls.

### D6 — The season pair moves to the new grass, and gets re-measured

`spring-green` / `late-season-cured` exist for one reason: to show what curing
does. They currently run FM2/FM5/FM10 because FM2 was the only Anderson model
with any live herbaceous load at all. This catalogue is what makes that pair mean
something, so the pair moves onto it (grass → a dynamic GR model, brush → a
dynamic GS/SH model, timber → TU) and its shipped figures (2.25× burned area,
1.60× mean intensity at one hour) are **re-measured**, not carried over. A second
season pair would be clutter.

The other three presets and `DEFAULT_TERRAIN_FUEL_MAPPING` do not move, so
`timber-crown-run`'s golden stands.

### D7 — Faithful transcription, including one oddity

TL5's live **woody** SAV reads `160` in `fuelModels.cpp` where the published table
and every sibling row say 1600. TL5 carries no live woody load, so the value is
inert in every calculation. It is transcribed as the source has it, with a note,
on the same principle as the `1.333 − 1.11·M` residue in §3c: our numbers match
the reference implementation's, and a silent "correction" is a divergence nobody
can see.

## Verification

**Transcription — machine-checked, not hand-restated.** A test that re-types the
literals proves nothing; it repeats the same slip. Instead a script parses
`fuelModels.cpp` into `tests/fixtures/sb40-fuelModels.json` (committed, with the
source revision recorded), and a test asserts the TypeScript catalogue matches the
fixture field for field. That is a genuine independent check on the hand step.

**Behaviour.** Extend the zero-wind port in `tests/rothermel-twocategory.test.ts`
across all 40 — it is already a verbatim port of `surfaceFuelbedIntermediates.cpp`
and needs no external source. **Done**, and it is worth its cost: these models put
shapes through the assembly that no Anderson model has (a live herbaceous *and* a
live woody class in one bed, the transferred fourth dead class, 1-hr SAVs at 750).
The port now lives in the repo as `tools/sb40ReferencePort.mjs` — written from the
C++, never importing `rothermel.ts` — and writes
`tests/fixtures/sb40-reference-r0.json`, which the test reads directly rather than
restating. Agreement across all forty models is ~1e-15 relative on R₀ **and** on
the live moisture of extinction, at dead 8 % / live 100 % with the transfer at its
0.223 mid-range fraction, so the transfer path is genuinely exercised.

Explicitly **not** used as a pin: the published spread-rate / flame-length tables
in GTR-153. It is not established that they were produced without Rothermel's
effective wind-speed limit (`0.9·I_R`), which this project deliberately does not
apply (§9), and that cap binds hardest on light grass — exactly the models this
phase is about.

**Structure.** Every Anderson bed byte-identical under the new default. A fully
cured GR model must produce a **dead-only** bed (its live herbaceous load goes to
zero and it has no live woody), the same path FM2 already takes.

## The claim to measure, stated before measuring

§3c's closing sentence is a prediction this phase must either confirm or retract —
and commit `d43a885` is this repo retracting a claim of exactly that shape after
measuring it. So, on the record first:

GR2 carries 0.10 tons/acre of dead 1-hr against 1.0 of live herbaceous — about
ten to one, where FM2 is one to seven the other way. Fully green, ~90 % of that
bed sits at 120 % moisture; fully cured, the same 90 % is dead fuel at the fine
dead moisture. So the expectation is **cured burns much more**, the opposite
direction from FM2 (which burned *less*, because moving load between categories
only changes which extinction moisture damps it, and FM2's dead M_x of 15 % damps
harder than its live M_x near 1044 %).

Measured green-vs-cured on **both** R₀ and fireline intensity — intensity because
that is what crown fire and ember production threshold on, and Phase 9 found it
moves about twice as far as spread — for GR2, GR4, GS2, TU1, TU3. If the grass
models move a lot and the grass–shrub and timber–understory ones barely move,
that is the finding and it gets written down as such.

## Results

**The prediction held, and by more than expected.** Green → cured (greenness
1 → 0, both halves, dead 6 / 10 / 9 %, midflame wind 350 ft/min), as a multiple:

| model | R₀ | fireline intensity |
|---|---|---|
| GR2 | ×50.2 | ×546 |
| GR4 | ×38.4 | ×327 |
| GS2 | ×10.4 | ×45.5 |
| TU1 | ×7.10 | ×22.8 |
| TU3 | ×3.02 | ×4.15 |
| *FM2, for scale* | *×1.32* | *×1.23* |

**The load half is now the dominant one**, reversing the Anderson finding: with
the season held at fully cured, turning the transfer on multiplies R₀ by 19.4 on
GR2 and 14.9 on GR4, where on FM2 it is 0.958. It still *flips sign* where the
herbaceous share is small — SH9 comes out ×0.895 on R₀ and ×0.751 on intensity,
exactly the FM2 mechanism — so §3c's explanation survives intact; it simply
usually points the other way in this catalogue. Written down as such rather than
generalised.

**Two results that were not predicted.**

1. For a dynamic grass model the transfer is a **precondition, not an
   enhancement.** Left in the live category, GR2's herbaceous load is damped
   against a live moisture of extinction that even 30 % exceeds, so ~90 % of the
   bed contributes nothing and R₀ stays under 0.2 ft/min at *every* season. The
   season pair run with `dynamicHerbLoad: false` burns 0.2 ha in an hour instead
   of 92.9. Serving these models with the transfer off would be serving them
   wrong — which retroactively justifies D4's default rather than leaving it a
   matter of taste.
2. A fully green landscape **does not carry fire at all**: at greenness ≥ 0.8 the
   pair's ignition dies inside five cells. Burned area at one hour over the ladder
   runs 0.1 / 0.4 / 5.0 / 11.3 / 19.4 / 58 / 154 / 269 / 372 / 450 ha at greenness
   1.0 / 0.8 / 0.7 / 0.6 / 0.5 / 0.4 / 0.3 / 0.2 / 0.1 / 0. Right physics, useless
   scenario — hence the amendment to D6 below.

**D6 as shipped.** Grass → GR2, brush → GS2 (both dynamic), timber → TU5 (static,
heavy) — mixed on purpose, so curing acts where the catalogue says it does and
nowhere else. Neither member sets `dynamicHerbLoad`; the catalogue's own flags do
the work. The **green member sits at greenness 0.6, not 1**, for the reason above,
and is renamed "Green season" so the description does not oversell it as a spring
flush. Re-measured at one hour, full size: **11.3 → 92.9 ha (×8.26)** and mean
fireline intensity **237 → 583 kW/m (×2.47)**, against the old pair's ×2.25 /
×1.60. Both members render as a legible fire.

**Cost.** No measurable change: no Rothermel maths moved, the bed caches keep their
existing keys, and the per-fuel gate is a branch on a preresolved object.

## Steps

1. Fixture generator + `tests/fixtures/sb40-fuelModels.json`.
2. `src/sim/scottBurgan40.ts` — the 40 rows, `SCOTT_BURGAN_40`, `StandardFuelModel`.
3. `RothermelFuel.dynamic?`; `Anderson13FuelModel` unchanged in behaviour.
4. `rothermelFireModel.ts` — the three-state option and the single resolver.
5. Tests: transcription, structure, Anderson byte-identity, the cured-GR dead-only
   bed, the two-category port across all 40.
6. Measure the curing lever. Write the numbers down.
7. Remap and re-measure the season pair.
8. `docs/science.md` §2 / §3c / §9, `CLAUDE.md` roadmap.
