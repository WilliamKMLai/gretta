import { defineConfig } from 'vitest/config';

/**
 * scripts/kb/store.sqlite.test.mts, run manually (`pnpm test:kb-native`).
 *
 * Excluded from `vitest.config.ts` — see the note there. This file loads the
 * better-sqlite3 native addon, which has crashed its Vitest worker in CI in
 * three different ways (forks pool, threads pool, and a from-source rebuild
 * of the addon) despite never failing locally. Kept in its own config, same
 * as the live smoke checks, so `pnpm check` never depends on it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['scripts/kb/store.sqlite.test.mts'],
    css: false,
  },
});
