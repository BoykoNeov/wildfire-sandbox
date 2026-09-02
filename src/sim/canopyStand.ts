/**
 * Scenario-level description of the tree canopy that the per-cell `canopy` byte
 * layer modulates. The layer (0..255) is a **canopy cover / bulk-density proxy**:
 * it says *how much* canopy is over a cell; this record says *what that canopy
 * is like* — stand height, crown ratio, and (for crown fire) crown base height,
 * peak bulk density and foliar moisture. One record per scenario, exactly as live
 * fuel moisture is one scalar per scenario (plan §D6): per-cell canopy *structure*
 * layers (LANDFIRE-style CBH/CBD/CH) are a data-import concern (handoff §5.3),
 * not part of the core sandbox.
 *
 * Consumers: {@link windAdjustmentFactor} (sheltering) and the crown-fire module.
 * The fire model reads it; nothing writes it at run time.
 */
export interface CanopyStand {
  /** Stand (canopy top) height [m]. Sheltering strengthens with a taller canopy. */
  standHeightM: number;
  /** Crown ratio — the fraction of the stand height occupied by live crown (0..1). */
  crownRatio: number;
}

/** A moderately tall conifer/mixed stand: 20 m, crowns over the upper half. */
export const DEFAULT_CANOPY_STAND: Readonly<CanopyStand> = {
  standHeightM: 20,
  crownRatio: 0.5,
};

/** Canopy byte (0..255) → canopy cover fraction (0..1). */
export function canopyCoverFraction(canopyByte: number): number {
  return canopyByte / 255;
}
