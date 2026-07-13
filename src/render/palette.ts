import { FireState, type WorldState } from '../core/world';
import { Fuel } from '../sim/basicFuelModel';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Map one cell to an RGB colour. Shared by every renderer (the on-screen canvas
 * and any headless exporter) so they never drift. Writes into `out` to avoid a
 * per-cell allocation in the hot loop.
 */
export function cellRGB(world: WorldState, i: number, out: Rgb): void {
  const { layers } = world;
  const state = layers.fire.data[i];
  if (state === FireState.Burning) {
    out.r = 255;
    out.g = 120 + ((i * 37) % 80);
    out.b = 0;
    return;
  }
  if (state === FireState.Burned) {
    out.r = 30;
    out.g = 26;
    out.b = 24;
    return;
  }
  const shade = 0.6 + (0.4 * layers.elevation.data[i]) / 1000;
  switch (layers.fuel.data[i]) {
    case Fuel.Grass:
      out.r = 150 * shade;
      out.g = 190 * shade;
      out.b = 90 * shade;
      return;
    case Fuel.Brush:
      out.r = 110 * shade;
      out.g = 150 * shade;
      out.b = 70 * shade;
      return;
    case Fuel.Timber:
      out.r = 50 * shade;
      out.g = 100 * shade;
      out.b = 55 * shade;
      return;
    case Fuel.CutLine:
      // Firefighter control line (Phase 4): a tan scratch of bared mineral soil,
      // distinct from grey rock so a hand/dozer line reads as built, not natural.
      out.r = 194 * shade;
      out.g = 168 * shade;
      out.b = 120 * shade;
      return;
    default: {
      // Nonburnable is either low-lying water or high bare rock; terrain gen puts
      // water below ~300 m and rock above ~820 m, so split on elevation instead of
      // painting mountain peaks lake-blue.
      if (layers.elevation.data[i] > 600) {
        out.r = 120 * shade;
        out.g = 118 * shade;
        out.b = 112 * shade; // bare rock (grey)
      } else {
        out.r = 60;
        out.g = 90;
        out.b = 140; // water
      }
    }
  }
}
