import { defineConfig } from 'vitest/config';

/**
 * The better-sqlite3 tests, run manually (`pnpm test:kb-native`).
 *
 * Excluded from `vitest.config.ts` — see the note there. These files load the
 * better-sqlite3 native addon, which has crashed its Vitest worker in CI in
 * three different ways (forks pool, threads pool, and a from-source rebuild
 * of the addon) despite never failing locally. Kept in its own config, same
 * as the live smoke checks, so `pnpm check` never depends on it.
 *
 * Globbed rather than listed: `migrate.test.mts` (ADR-036) was written and
 * then silently not run, because the include was a single filename.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['scripts/kb/*.sqlite.test.mts', 'scripts/kb/migrate.test.mts'],
    css: false,
  },
});
