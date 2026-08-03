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
     *
     * store.sqlite.test.mts (the only file loading the better-sqlite3 native
     * addon) is excluded too. In CI it has crashed its Vitest worker under
     * the default `forks` pool ("Worker exited unexpectedly" —
     * vitest-dev/vitest#8968 et al.), under `threads` (an actual SIGSEGV),
     * and even with a from-source rebuild of the addon ruling out a prebuild
     * ABI mismatch — three different causes tried and ruled out, and it has
     * never failed locally. Whatever's wrong is specific to how Vitest 4
     * manages worker processes around this native module on that runner.
     * Run it manually with `pnpm test:kb-native`; move it back once
     * upstream stabilizes.
     */
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/**/*.smoke.test.ts',
      'scripts/kb/store.sqlite.test.mts',
    ],
    css: false,
  },
});
