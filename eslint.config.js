import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * GRETTA lint policy (ARCHITECTURE.md §5.1–§5.2).
 *
 * Two mechanical guarantees are enforced here rather than by convention:
 *  1. The layer graph — dependencies point downward only (eslint-plugin-boundaries).
 *  2. "Rule zero" — Office.js, fetch, and localStorage are reachable **only** from
 *     the services layer (no-restricted-globals everywhere else).
 *
 * 3. Cross-element imports of services/* and features/* go through their
 *    index.ts barrels only (`boundaries/entry-point`, added in Phase 5).
 */
export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'coverage', 'playwright-report', 'test-results'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // React hooks correctness for all app code.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // Layer dependency graph.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { alwaysTryTypes: true } },
      'boundaries/include': ['src/**/*'],
      // Folder-mode elements: the pattern names the element's root folder, and
      // every file inside belongs to that one element, so same-service /
      // same-layer imports are "internal" and always allowed.
      'boundaries/elements': [
        { type: 'main', mode: 'file', pattern: 'src/main.tsx' },
        { type: 'env', mode: 'file', pattern: 'src/vite-env.d.ts' },
        // The composition root is its own element so features can reach
        // getServices() without importing the rest of app/ (ADR-003 amendment).
        { type: 'services-root', mode: 'file', pattern: 'src/app/services.ts' },
        { type: 'commands', pattern: 'src/commands' },
        { type: 'app', pattern: 'src/app' },
        { type: 'features', pattern: 'src/features/*', capture: ['feature'] },
        { type: 'components', pattern: 'src/components' },
        { type: 'hooks', pattern: 'src/hooks' },
        { type: 'services', pattern: 'src/services/*', capture: ['service'] },
        { type: 'types', pattern: 'src/types' },
        { type: 'utils', pattern: 'src/utils' },
        { type: 'styles', pattern: 'src/styles' },
      ],
    },
    rules: {
      'boundaries/no-unknown': 'error',
      'boundaries/no-unknown-files': 'error',
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          message:
            '${file.type} may not import ${dependency.type} (layer rules: ARCHITECTURE.md §5.2)',
          rules: [
            { from: 'main', allow: ['app', 'services-root', 'services', 'styles', 'types'] },
            {
              from: 'app',
              allow: [
                'app',
                'services-root',
                'features',
                'components',
                'hooks',
                'services',
                'types',
                'utils',
                'styles',
              ],
            },
            {
              from: 'features',
              allow: [
                'features',
                'services-root',
                'components',
                'hooks',
                'services',
                'types',
                'utils',
              ],
            },
            { from: 'components', allow: ['components', 'types', 'utils', 'styles'] },
            { from: 'hooks', allow: ['hooks', 'services-root', 'services', 'types', 'utils'] },
            // Same-service imports are "internal" to one element instance and always
            // allowed; listing nothing service-shaped here is what bans cross-service
            // imports (office ↛ ollama), per ARCHITECTURE §5.2 note 2.
            { from: 'services', allow: ['types', 'utils'] },
            { from: 'services-root', allow: ['features', 'services', 'types', 'utils'] },
            { from: 'utils', allow: ['types', 'utils'] },
            { from: 'types', allow: ['types'] },
            { from: 'commands', allow: ['types'] },
          ],
        },
      ],
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',
          message: 'Import ${dependency.type} through its index.ts barrel (ARCHITECTURE.md §5.2)',
          rules: [
            { target: ['services', 'features'], allow: 'index.ts' },
            {
              target: [
                'main',
                'env',
                'commands',
                'app',
                'services-root',
                'components',
                'hooks',
                'types',
                'utils',
                'styles',
              ],
              allow: '*',
            },
          ],
        },
      ],
    },
  },

  // Rule zero: platform globals only inside the services layer (and the two
  // entry runtimes that exist to hand control to it).
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/services/**', 'src/commands/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Network access goes through services/ollama (rule zero).' },
        { name: 'Office', message: 'Office.js is wrapped by services/office (rule zero).' },
        { name: 'Word', message: 'Office.js is wrapped by services/office (rule zero).' },
        {
          name: 'localStorage',
          message: 'Persistence goes through services/storage (rule zero).',
        },
      ],
    },
  },

  // Node-side plain JS/MJS (proxy script, this config): no type-aware rules.
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },

  // The knowledge-base companion is authored in strict TypeScript and RUN by
  // Node's type stripping (ADR-020) — so it stays type-checked, but may only
  // use erasable syntax. Anything Node cannot strip is a lint error here.
  {
    files: ['scripts/kb/**/*.mts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Erasable TS only (ADR-020): no enums.' },
        { selector: 'TSModuleDeclaration', message: 'Erasable TS only (ADR-020): no namespaces.' },
        {
          selector: 'TSParameterProperty',
          message: 'Erasable TS only (ADR-020): no constructor parameter properties.',
        },
      ],
    },
  },

  // Prettier owns formatting; disable stylistic conflicts.
  prettier,
);
