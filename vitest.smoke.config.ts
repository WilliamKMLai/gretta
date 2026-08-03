import { defineConfig } from 'vitest/config';

/**
 * Live API smoke checks (`pnpm smoke:lit`).
 *
 * Separate from `vitest.config.ts` because these run against the node
 * environment while everything else runs against jsdom, and mixing the two in
 * one run is unreliable under parallelism — see the note in that file. Keeping
 * them apart also means `pnpm check` never depends on a third party being up.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.smoke.test.ts'],
    // No setup file: the DOM stubs there are meaningless outside jsdom.
    css: false,
  },
});
