# Phase 9 — fuel moisture: per-class dead, and a live-fuel curve

Two of the four honest gaps `docs/science.md` §9 was still carrying, taken
together because they are the same shape: the fuel bed was being handed **one**
dead moisture and **one** live moisture, where the science asks for three and
two. Both were booked as deferred — per-class dead moisture as item 1 of the
Phase-2 plan's §D6 upgrade ladder, live moisture as a §9 bullet.

Neither is a new model. `rothermel.ts` has always carried a `moisture` per fuel
particle; both parts are changes to **bed assembly** in `anderson13.ts` plus the
scenario inputs that drive them. No change to the Rothermel math, no change to
the `layers.moisture` encoding, no new system, no pipeline change.

## Part 1 — per-size-class dead moisture ✅

### The decision that shaped it: constants, not a layer, and not an offset

The §D6 entry proposed either independent per-class layers or "a coarse-fuel
offset from the painted fine moisture". Both were rejected.

**Not an offset.** §D6 was written in Phase 2, when `layers.moisture` was a
static painted layer. Phase 3 made it *dynamic* — fine dead fuel now relaxes
toward the Simard equilibrium on a 1-hour timelag and wets under rain. A constant
offset from a moving fine layer makes the 100-hr logs chase the 1-hr grass: a
rain pulse that drives the fine class to 60% would drag the coarse classes up
with it, which is precisely backwards from the thing worth modelling.

**Not layers either.** The honest reason is run length, not cost: the 10-hr and
100-hr timelags are longer than an entire sandbox run, so within a burn the
coarse classes barely move. What matters is the antecedent condition the run
*starts* in — which is exactly what BehavePlus asks its user for
(`moistureScenarios.cpp` ships four dead triples: 3/4/5, 6/7/8, 9/10/11,
12/13/14 %). So the coarse classes are **absolute scenario-level constants**.

That choice pays a second dividend. A prepared fuel bed stays a pure function of
(fuel id, fine moisture byte), so `RothermelFireModel`'s bed cache keeps its
single 256-wide moisture axis. Three independent per-cell moisture bytes would
have made the key space 256³ per fuel and destroyed the Phase-7 caching that
holds the fire model inside its frame budget.

The cost, recorded in §9: coarse dead moisture is spatially **uniform** while the
fine layer keeps its wet-valley / dry-ridge pattern. With map-uniform weather
drivers the fine layer is the only spatial information the sim has, so this buys
little — but it is a real simplification, not a free one.

### What changed

- `anderson13.ts` — new `BedMoisture` (all fields optional, all absolute
  fractions); `deadFuelBed(m, dead1h, moisture?)` and
  `fuelBed(m, dead1h, live, moisture?)` distribute per class, each field falling
  back to its positional value. **Omitting the argument reproduces the previous
  bed exactly**, which is what keeps every pinned test byte-identical.
- `rothermelFireModel.ts` — `dead10hMoisture` / `dead100hMoisture` options, built
  once into a shared `BedMoisture` (or left `undefined`) and passed to both the
  surface and the FM10 crown-proxy bed. No allocation in the hot loop.
- Scenarios pass fire-model options straight through, so no scenario plumbing.

Everything downstream picked the split up for free, because it all reads
per-particle moisture already: the heat sink Q_ig, the surface-area-weighted dead
category moisture in η_M, and Albini's fineness-weighted dead moisture inside
M_x,live.

### Measured, before the doc sentence was written

R₀ and fireline-intensity ratios against a uniform 6% dead bed, at
1-hr 6% / 10-hr 15% / 100-hr 25% — an antecedent far outside the standard triples,
chosen to *bound* the effect. Full table in `docs/science.md` §3a.

- **Single-dead-class models cannot move at all**: FM1 and FM3 are exactly 1.000.
- Under BehavePlus's own 6/7/8 triple, the largest model moves **1.6%**.
- At the extreme 6/15/25, R₀ ranges 0.996× (FM9 long-needle litter) to 0.891×
  (FM13 heavy slash).
- **Fireline intensity moves about twice as far** — down to 0.811× on FM13,
  0.933× on FM10, the bed that drives crown fire.

So: a small lever on how fast a flank creeps, a meaningful one on whether a stand
torches. That asymmetry is the point of the feature, and it is why the honest
place to look for it is the crown-fire and spotting thresholds, not the front
speed. The reason it is small is structural — the heat sink weights each particle
by exp(−138/σ), which is ≈ 0.93 for fine fuel, 0.28 at the 10-hr SAV of 109 and
0.010 at the 100-hr SAV of 30, and η_M weights the category moisture by surface
area, punishing coarse fuel again.

## Part 2 — live fuel moisture from a greenness curve

*(see the commit that lands it; design notes below)*

Live moisture was a single scenario scalar applied to both live classes. The
science ships it as a **two-column ladder** keyed on how cured the herbaceous
fuel is (BehavePlus `moistureScenarios.cpp`):

| | live herbaceous | live woody |
|---|---|---|
| fully cured | 30% | 60% |
| 2/3 cured | 60% | 90% |
| 1/3 cured | 90% | 120% |
| fully green | 120% | 150% |

Both columns are linear in the curing fraction, so one knob `greenness` ∈ [0, 1]
(0 = fully cured, 1 = fully green) reproduces all four rows exactly:

    liveHerb  = 0.30 + 0.90 · greenness
    liveWoody = 0.60 + 0.90 · greenness

This also delivers the live-herb / live-woody split that `anderson13.ts` had
flagged as a separate cheap deferral — it comes free with the curve.

**Naming, deliberately narrow.** The knob is *not* called `curing`. In real
BehavePlus, curing's dominant effect is transferring cured live-herbaceous **load**
into the dead 1-hr class, and dead fine fuel is what carries fire — a much bigger
lever than moisture. The Anderson 13 models are static and carry no transfer, so
implementing only the moisture half under the name `curing` would name the knob
after the effect it does not have. Load transfer stays a recorded deferral.

`liveMoisture` keeps working and keeps winning when given, so every existing
preset and pinned test is untouched; `greenness` is opt-in.
