/**
 * Fuel-moisture byte↔fraction convention for `layers.moisture` (Phase-2 plan D6).
 *
 * The world stores fuel moisture as a Uint8 (0..255) so it is compact and
 * paintable by the editor; the Rothermel model needs a moisture *fraction*
 * (e.g. 0.06 = 6%). The mapping is deliberately **linear** — `0` = bone dry,
 * `255` = 100% — and must stay linear: the editor writes bytes against it and
 * saved scenarios encode it, so a hidden "realistic-band" remap would mislead
 * every future reader. If terrain burns poorly because cells sit near their
 * moisture of extinction, fix the bytes written in terrain generation, not this
 * convention.
 *
 * SCOPE: this layer is **dead**-fuel moisture. 0..1.0 is ample for dead fuel
 * (moisture of extinction tops out ~0.40). Live fuel moisture runs 100–300% and
 * has its own representation now that the dead/live split has landed — a
 * scenario-level scalar on `RothermelFireModel`, not this layer. Do not push live
 * moisture through these helpers. See `docs/plans/phase-2-science-anchor.md` D6
 * and `docs/plans/phase-3-moisture-dynamics.md`.
 */

/** Maximum moisture byte — the fully-saturated (100%) end of the 0..255 range. */
export const MOISTURE_BYTE_MAX = 255;

/** Convert a stored moisture byte (0..255) to a moisture fraction (0.0..1.0). */
export function byteToFraction(byte: number): number {
  return byte / MOISTURE_BYTE_MAX;
}

/**
 * Convert a moisture fraction (0.0..1.0) to a stored byte (0..255). Fractions
 * outside [0, 1] are clamped; the result is rounded to the nearest byte, so a
 * byte round-trips exactly (`fractionToByte(byteToFraction(b)) === b`).
 */
export function fractionToByte(fraction: number): number {
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  return Math.round(clamped * MOISTURE_BYTE_MAX);
}
