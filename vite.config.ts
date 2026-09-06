import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Vitest's default is 5 s, and a good number of these tests run hundreds to
    // thousands of ticks of the *whole* mounted pipeline rather than a pure
    // function — `render.test.ts` and the `scenario.test.ts` preset loop both
    // cross 5 s on a machine running the suite's own workers in parallel. Every
    // failure that produced was a timeout, never an assertion, so the fix
    // belongs here rather than as a per-test override sprinkled over whichever
    // test happened to lose the race that run. Two tests carry their own
    // `{ timeout: 30000 }` from before this existed; they are harmless.
    testTimeout: 30000,
  },
});
