/** Simulation clock — plain mutable data, advanced by the Simulation each step. */
export interface SimClock {
  /** Number of completed steps. */
  tick: number;
  /** Elapsed simulated time, in seconds. */
  time: number;
}

export function createClock(): SimClock {
  return { tick: 0, time: 0 };
}
