import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** Unit/component test runner (ARCHITECTURE.md §14). E2E lives in playwright.config.ts. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    /*
     * An explicit origin, because `localStorage` depends on it.
     *
     * jsdom only exposes storage for a non-opaque origin — a document at
     * `about:blank` has none, and `window.localStorage` is then undefined
     * rather than throwing. Relying on the default left the suite passing on
     * one machine and failing 56 tests on another with
     * "Cannot read properties of undefined (reading 'clear')", every failure in
     * a file that touches storage. Naming the origin removes the dependency on
     * whatever the default happens to be.
     */
    environmentOptions: { jsdom: { url: 'https://localhost:3000' } },
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/kb/**/*.test.mts'],
    /*
     * Smoke files are excluded from the default run and have their own config.
     *
     * They need the node environment — Node's `fetch` rejects an `AbortSignal`
     * built by jsdom's realm — and a per-file `@vitest-environment` docblock is
     * the obvious way to get it. It is also a trap: it forces an environment
     * switch inside an otherwise-jsdom run, and under enough parallelism
     * workers get reused across environments and `window.localStorage`
     * disappears mid-suite. That produced 56 failures on an 8-core machine and
     * none on a slower one, which is the worst shape a test failure can take.
     *
     * Separating the runs removes the mixing rather than papering over it.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.smoke.test.ts'],
    css: false,
    /*
     * Vitest 4's rewritten `forks` pool has open reports of a worker process
     * dying mid-run under CI-like load, surfacing as an opaque "[vitest-pool]:
     * Worker forks emitted error" with no test-level failure attached (see
     * vitest-dev/vitest#9762, #8766, #8861, #8968). It hit us on the one file
     * that loads a native addon (better-sqlite3) — nothing wrong with that
     * file, the fork running it just never reported back. Capping concurrency
     * gives forked workers more headroom on GitHub's runners; raise this once
     * upstream stabilizes the new pool.
     */
    maxWorkers: 2,
  },
});
