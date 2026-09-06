/**
 * The machinery shared by every *catalogue* of standard fire-behaviour fuel
 * models — Anderson 13 (`anderson13.ts`) and Scott & Burgan 40
 * (`scottBurgan40.ts`) — so that adding a catalogue is a table of rows and
 * nothing else.
 *
 * A catalogue is a `number → CatalogueModel` map. {@link CatalogueFuelModel}
 * turns one into the `IFuelModel` seam the fire models read. Nothing here knows
 * any fuel science; the numbers live in the catalogue modules and the maths in
 * `rothermel.ts`.
 */
import type { FuelParams, IFuelModel, RothermelFuel } from '../models/IFuelModel';

/** A catalogue entry: a model's identity plus its Rothermel descriptors. */
export interface CatalogueModel extends RothermelFuel {
  /** Published model number (1–13 for Anderson, 101–204 for Scott & Burgan). */
  number: number;
  /** Short code, e.g. "FM1", "GR2". */
  code: string;
  /** Common name. */
  name: string;
}

/** Nonburnable: id 0, and anything a catalogue does not define. */
const NONBURNABLE: FuelParams = { burnable: false, spreadRate: 0, burnDuration: 0 };

/**
 * The `FuelParams` for one catalogue model. The legacy CA fields
 * (`spreadRate`/`burnDuration`) are inert zeros — standard fuel models are meant
 * for the Rothermel fire model, which derives burnout from fuel residence time,
 * not for the Phase-1 CA.
 */
export function catalogueParams(m: CatalogueModel): FuelParams {
  return {
    burnable: true,
    spreadRate: 0,
    burnDuration: 0,
    rothermel: {
      dead1hLoad: m.dead1hLoad,
      dead10hLoad: m.dead10hLoad,
      dead100hLoad: m.dead100hLoad,
      liveHerbLoad: m.liveHerbLoad,
      liveWoodyLoad: m.liveWoodyLoad,
      dead1hSav: m.dead1hSav,
      liveHerbSav: m.liveHerbSav,
      liveWoodySav: m.liveWoodySav,
      depth: m.depth,
      deadMx: m.deadMx,
      heatContent: m.heatContent,
      dynamic: m.dynamic === true,
    },
  };
}

/**
 * Serves a catalogue through the `IFuelModel` seam. `getParams` takes a **native
 * published model number**; 0 or any number the catalogue does not define is
 * nonburnable. Mapping the world's generic terrain ids onto model numbers is a
 * wiring concern handled where the world is built (`terrainFuelModel.ts`), not
 * here.
 */
export class CatalogueFuelModel implements IFuelModel {
  // `FuelParams` are immutable data, so build one object per model number and
  // hand back the same reference on every call. The Rothermel fire model calls
  // `getParams` for every non-burned cell each tick (~millions/sec on a full
  // grid); without this cache each call allocated a fresh nested object, pure GC
  // churn against the per-cell performance invariant. Indexed by fuel id, not a
  // Map, to keep the hot-loop lookup a plain array read.
  private readonly cache: FuelParams[] = [];

  constructor(private readonly catalogue: ReadonlyMap<number, CatalogueModel>) {}

  getParams(fuelType: number): FuelParams {
    const cached = this.cache[fuelType];
    if (cached) return cached;
    const m = this.catalogue.get(fuelType);
    const params = m ? catalogueParams(m) : NONBURNABLE;
    this.cache[fuelType] = params;
    return params;
  }
}
