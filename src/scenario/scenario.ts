import { createWorld, FireState, type WorldState } from '../core/world';
import { Simulation } from '../core/simulation';
import type { System } from '../core/system';
import { generateTerrain, igniteNearestBurnable, type TerrainOptions } from '../gen/terrain';
import { TerrainFuelModel, DEFAULT_TERRAIN_FUEL_MAPPING, type TerrainFuelMapping } from '../sim/terrainFuelModel';
import {
  DynamicWeatherProvider,
  type AmbientKeyframe,
  type GustOptions,
  type WindKeyframe,
} from '../sim/dynamicWeather';
import { FuelMoistureSystem } from '../sim/fuelMoistureSystem';
import { RothermelFireModel, type RothermelFireModelOptions } from '../sim/rothermelFireModel';
import { DEFAULT_CANOPY_STAND, type CanopyStand } from '../sim/canopyStand';
import { SpottingSystem } from '../sim/spottingSystem';
import { GroundCrew } from '../sim/groundCrew';
import { Engine, type EngineOptions } from '../sim/engine';
import { Aircraft, type AircraftOptions } from '../sim/aircraft';
import { RetardantSystem } from '../sim/retardantSystem';
import { Fuel } from '../sim/basicFuelModel';

/**
 * Phase-5b scenarios (`docs/plans/phase-5-polish.md` decision #4). A
 * {@link Scenario} is **plain data** — seed, dims, terrain options, fuel
 * mapping, fire-model options, weather keyframes, ignitions and the agent
 * roster — consumed *before* the run starts. {@link loadScenario} is the ONE
 * builder both the browser entry (`main.ts`) and the headless exporter
 * (`tools/renderFrame.ts`) call, so the two pipelines cannot drift. Loading
 * builds a fresh world; it never mutates a live one, and it writes nothing into
 * world state afterwards (decision #1). The seeded RNG makes every preset
 * byte-for-byte reproducible — the roadmap's own parenthetical, delivered
 * without any serialization code.
 *
 * Pipeline order is load-bearing and lives here, in one place:
 *   weather → moisture → crew → engine → aircraft → retardant → fire → spotting
 * (see each agent's header for why suppression sits after moisture and before
 * fire, and `SpottingSystem` for why spotting must follow the fire model).
 */

/** A cell position. */
export interface CellPos {
  x: number;
  y: number;
}

export interface ScenarioWeather {
  /** Mean-wind keyframes (m/s; midflame or 20-ft per `fireModel.windReference`). */
  wind: WindKeyframe[];
  /** Ambient drivers: constants, or keyframes for a weather front. */
  ambient: AmbientKeyframe[] | Omit<AmbientKeyframe, 'time'>;
  /** Drifting gust field; omit for spatially-uniform wind. `seed` defaults to the scenario seed. */
  gust?: GustOptions;
}

export interface ScenarioAgents {
  /** Hand crew start cell. */
  crew?: CellPos;
  /** Engine start (+ optional refill point etc.). */
  engine?: EngineOptions;
  /** Air tanker base. */
  aircraft?: AircraftOptions;
}

export interface Scenario {
  /** Stable id (URL/CLI key), e.g. `shifting-winds`. */
  id: string;
  /** Display name. */
  name: string;
  /** One or two sentences: what this unit teaches. */
  description: string;
  seed: number;
  width: number;
  height: number;
  /** Metres per cell. Default 30. */
  cellSize?: number;
  terrain?: TerrainOptions;
  /** Anderson numbers for the generic terrain classes. Default FM1/FM6/FM9. */
  fuelMapping?: TerrainFuelMapping;
  /** Rothermel fire-model options; `canopy` may be partial (merged over the default stand). */
  fireModel?: Omit<RothermelFireModelOptions, 'canopy'> & { canopy?: Partial<CanopyStand> };
  weather: ScenarioWeather;
  /**
   * Ignition cells, or `'center'`. Every ignition lights the nearest burnable
   * cell to the requested point (the map centre for `'center'`), so an authored
   * point that lands on water or rock still starts a fire beside it.
   */
  ignitions: CellPos[] | 'center';
  /** Player-commanded units. Omit an entry to leave that unit out. */
  agents?: ScenarioAgents;
  /** Include the spotting system. Default true. */
  spotting?: boolean;
  /** Suggested sim-seconds per real second for the browser loop. Default 120. */
  timeScale?: number;
}

/** Everything `loadScenario` builds. Agents are `null` when the scenario omits them. */
export interface LoadedScenario {
  scenario: Scenario;
  world: WorldState;
  sim: Simulation;
  systems: System[];
  fuel: TerrainFuelModel;
  crew: GroundCrew | null;
  engine: Engine | null;
  aircraft: Aircraft | null;
  /** Burnable cells at load — the denominator for "landscape consumed" stats. */
  burnableCells: number;
}

/** Build a fresh world + system pipeline for a scenario. Pure of side effects beyond the returned objects. */
export function loadScenario(s: Scenario): LoadedScenario {
  const world = createWorld({ width: s.width, height: s.height, seed: s.seed, cellSize: s.cellSize });
  generateTerrain(world, s.terrain);

  if (s.ignitions === 'center') {
    igniteNearestBurnable(world, s.width >> 1, s.height >> 1);
  } else {
    for (const p of s.ignitions) igniteNearestBurnable(world, p.x, p.y);
  }

  const fuel = new TerrainFuelModel(s.fuelMapping ?? DEFAULT_TERRAIN_FUEL_MAPPING);

  const ambient = Array.isArray(s.weather.ambient)
    ? { ambient: s.weather.ambient }
    : { ...s.weather.ambient };
  const gust = s.weather.gust ? { seed: s.seed, ...s.weather.gust } : undefined;
  const weather = new DynamicWeatherProvider(s.weather.wind, { ...ambient, gust });
  const moisture = new FuelMoistureSystem();

  const fm = s.fireModel ?? {};
  const fire = new RothermelFireModel(fuel, {
    ...fm,
    canopy: { ...DEFAULT_CANOPY_STAND, ...(fm.canopy ?? {}) },
  });

  const crew = s.agents?.crew ? new GroundCrew(fuel, s.agents.crew) : null;
  const engine = s.agents?.engine ? new Engine(s.agents.engine) : null;
  const aircraft = s.agents?.aircraft ? new Aircraft(s.agents.aircraft) : null;
  const retardant = aircraft ? new RetardantSystem() : null;

  const systems: System[] = [weather, moisture];
  if (crew) systems.push(crew);
  if (engine) systems.push(engine);
  if (aircraft) systems.push(aircraft);
  if (retardant) systems.push(retardant);
  systems.push(fire);
  if (s.spotting ?? true) systems.push(new SpottingSystem(fuel));

  const sim = new Simulation(world, systems);

  let burnableCells = 0;
  const fuelL = world.layers.fuel.data;
  const fireL = world.layers.fire.data;
  for (let i = 0; i < fuelL.length; i++) {
    if (fuelL[i] !== Fuel.Nonburnable && fuelL[i] !== Fuel.CutLine && fireL[i] === FireState.Unburned) burnableCells++;
  }

  return { scenario: s, world, sim, systems, fuel, crew, engine, aircraft, burnableCells };
}
