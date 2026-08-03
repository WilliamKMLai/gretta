import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

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
const environmentOptions = { jsdom: { url: 'https://localhost:3000' } };

/** Unit/component test runner (ARCHITECTURE.md §14). E2E lives in playwright.config.ts. */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'default',
          environment: 'jsdom',
          environmentOptions,
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
           *
           * store.sqlite.test.mts is excluded too — see the `kb-native` project
           * below for why it needs its own pool.
           */
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'src/**/*.smoke.test.ts',
            'scripts/kb/store.sqlite.test.mts',
          ],
          css: false,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'kb-native',
          environment: 'jsdom',
          environmentOptions,
          globals: true,
          setupFiles: ['./tests/setup.ts'],
          include: ['scripts/kb/store.sqlite.test.mts'],
          css: false,
          /*
           * Vitest 4's rewritten `forks` pool (the default) has an open bug where a
           * forked child process loading a native addon can finish loading but stop
           * polling for IPC messages, so the parent sees a bare "Worker exited
           * unexpectedly" with no test-level failure (vitest-dev/vitest#8968,
           * #8766, #8861, #9762). This is the only file that loads a native addon
           * (better-sqlite3), and it reproduced the bug twice in CI — reducing
           * `maxWorkers` for the whole suite did not help, which rules out plain
           * worker-pool contention as the cause. Running just this file under
           * `threads` instead of `forks` sidesteps the specific IPC-polling bug;
           * move it back once upstream fixes the forks pool.
           */
          pool: 'threads',
        },
      },
    ],
  },
});
