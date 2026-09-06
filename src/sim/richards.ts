/**
 * Richards' elliptical growth equations — how a **point on a fire perimeter**
 * moves, as against how fast a fire spreads in a given direction.
 *
 * Rothermel gives a head rate; `fireEllipse.ts` turns that into a rate in any
 * direction *from the ignition point*. Neither says how a marker sitting on the
 * fire edge should travel: that depends on the perimeter's local **tangent**,
 * because each marker carries its own little ellipse and the front is their
 * envelope (Huygens' principle). Richards (1990), *An elliptical growth model of
 * forest fire fronts and its numerical solution*, Int. J. Numer. Methods Eng.
 * 30:1163–1179, writes that envelope in closed form, and FARSITE propagates with
 * it.
 *
 * **Source.** `firelab/behave` does not cover this — BehavePlus is a *point*
 * model library and has no propagation at all. The transcription is from the
 * FARSITE 4 C++ (`edigley/farsite`), `fsxwmech.cpp`: `Mechanix::grow` at :588 for
 * the growth equations and `Mechanix::ellipse` at :1370 for the dimensions. Same
 * standing as BehavePlus does to Rothermel — the reference implementation, not a
 * remembered formula (`docs/plans/phase-11-smooth-wavefront.md` §2).
 *
 * Pure functions of scalars: no world state, no RNG, no trigonometry.
 */

/**
 * The spread ellipse as **dimensions** rather than rates — which is the single
 * easiest thing to get wrong here, because FARSITE's `ellipse()` reuses the
 * names `head`/`flank`/`back` for both and reassigns them in place.
 *
 * With `R` the Rothermel head rate and `B` the backing rate, FARSITE's
 * `headback()` + `ellipse()` leave behind the semi-major axis `(R+B)/2`, the
 * semi-minor `(R+B)/(2·LB)` and the focus offset `(R−B)/2`. Plugging the raw
 * head rate in as the semi-major axis still produces something that looks like a
 * fire, which is why this record exists instead of three loose numbers.
 *
 * All three are **rates** dimensionally (length per unit time): they are the
 * axes of the ellipse the fire would grow into in unit time.
 */
export interface EllipseDimensions {
  /** Semi-major axis `a` — FARSITE's `head` after the reassignment. */
  a: number;
  /** Semi-minor axis `b` — FARSITE's `flank`. */
  b: number;
  /** Offset from the centre to the focus, `c = a·E` — FARSITE's `back`. */
  c: number;
}

/**
 * The spread ellipse's dimensions from the head rate and the eccentricity this
 * repo already carries (`fireEllipse.ts`), written into `out`.
 *
 * FARSITE reaches them through Alexander's head/backing ratio,
 * `HB = (LB + √(LB²−1))/(LB − √(LB²−1))`, which — as the plan's §2b works out —
 * is our `backingRate` in disguise: `1/HB = (1−E)/(1+E)`. So the dimensions
 * follow from `E` alone, with no length-to-breadth round trip:
 *
 * ```
 *   B = R·(1−E)/(1+E)          backing rate
 *   a = (R + B)/2 = R/(1+E)
 *   c = (R − B)/2 = R·E/(1+E) = a·E
 *   b = a/LB      = a·√(1−E²)  = R·√((1−E)/(1+E))
 * ```
 *
 * At `E = 0` this is `a = b = R`, `c = 0` — a circle of radius `R`, as it must
 * be. That the focus offset comes out as `a·E` and the semi-minor as
 * `a·√(1−E²)` is the standard ellipse identity, i.e. the two derivations agree:
 * FARSITE's `lb_ratio` and this repo's `lengthToBreadthRatio` are the same
 * Anderson-1983 correlation, cap of 8 included (plan §2b).
 */
export function ellipseDimensions(headRate: number, ecc: number, out: EllipseDimensions): EllipseDimensions {
  if (!(ecc > 0)) {
    out.a = headRate;
    out.b = headRate;
    out.c = 0;
    return out;
  }
  const a = headRate / (1 + ecc);
  out.a = a;
  out.b = headRate * Math.sqrt((1 - ecc) / (1 + ecc));
  out.c = a * ecc;
  return out;
}

/** The velocity {@link richardsVelocity} writes. */
export interface MarkerVelocity {
  vx: number;
  vy: number;
}

/**
 * Richards' growth equations: the velocity of one perimeter marker, given the
 * perimeter tangent there and the cell's spread ellipse.
 *
 * FARSITE writes it in compass azimuth (`x = sin θ` east, `y = cos θ` north);
 * substituting `u = sin θ`, `v = cos θ` and the two projections of the tangent
 * `(x_s, y_s)`
 *
 * ```
 *   p = x_s·u + y_s·v          along the head
 *   q = x_s·v − y_s·u          across it
 *   D = √(b²·q² + a²·p²)       (FARSITE's h → a, f → b)
 * ```
 *
 * turns `grow()` into the same algebra with **no trigonometry at all**:
 *
 * ```
 *   vx = ( b²·v·p − a²·u·q)/D + c·u
 *   vy = (−b²·u·p − a²·v·q)/D + c·v
 * ```
 *
 * which matters, because this runs per marker per substep rather than per cell
 * per tick.
 *
 * ### Handedness and winding
 *
 * Rewritten in basis form the velocity is
 * `V = −(a²q/D)·ĥ + (b²p/D)·ĝ + c·ĥ`, where `ĥ = (u, v)` is the head direction
 * and `ĝ = (v, −u)`. It therefore depends on the frame only through how `ĝ` and
 * the winding relate — which pins the convention, by derivation rather than by
 * hoping:
 *
 * **Vertices are stored counter-clockwise as seen on screen** (x right, y down),
 * with the tangent taken as `previous − next` (FARSITE's `xdiff = xptl − xptn`,
 * `fsxwmech.cpp:168`). Under that convention, applying the formulas verbatim in
 * screen coordinates gives, on an ellipse whose head points along `ĥ`:
 *
 * | marker | tangent | velocity |
 * |---|---|---|
 * | head | across `ĥ` | `(a + c)·ĥ` = the Rothermel head rate `R` |
 * | back | across `ĥ` (other sense) | `(c − a)·ĥ` = the backing rate, pointing backwards |
 * | flank | along `ĥ` | `b` outward, i.e. the semi-minor rate |
 * | any, `E = 0` | any | `R` along the outward normal — a circle |
 *
 * That is the whole correctness argument, and `tests/richards.test.ts` pins all
 * four cases plus the mirror: **a mirrored ellipse has identical anisotropy,
 * identical length-to-breadth at every wind speed and the same radius at every
 * angle off the axis**, so only a signed direction check can see the error (plan
 * §2c).
 *
 * A degenerate tangent (coincident neighbours) yields zero velocity, matching
 * FARSITE's `if (xdiff == 0 && ydiff == 0)` guard — the backing term is dropped
 * too, deliberately: with no tangent there is no local perimeter to move.
 */
export function richardsVelocity(
  dim: EllipseDimensions,
  headUx: number,
  headUy: number,
  tangentX: number,
  tangentY: number,
  out: MarkerVelocity,
): MarkerVelocity {
  if (tangentX === 0 && tangentY === 0) {
    out.vx = 0;
    out.vy = 0;
    return out;
  }
  const u = headUx;
  const v = headUy;
  const p = tangentX * u + tangentY * v;
  const q = tangentX * v - tangentY * u;
  const a2 = dim.a * dim.a;
  const b2 = dim.b * dim.b;
  const d = Math.sqrt(a2 * q * q + b2 * p * p);
  if (!(d > 0)) {
    out.vx = 0;
    out.vy = 0;
    return out;
  }
  out.vx = (b2 * v * p - a2 * u * q) / d + dim.c * u;
  out.vy = (-b2 * u * p - a2 * v * q) / d + dim.c * v;
  return out;
}
