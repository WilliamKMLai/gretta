import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * GRETTA Vite configuration (ARCHITECTURE.md §5.3, DECISIONS.md ADR-002).
 *
 * Entries:
 *  - taskpane.html  → the add-in UI (manifest <SourceLocation>)
 *  - commands.html  → the function-command runtime (manifest <FunctionFile>)
 *
 * Modes:
 *  - default        → HTTPS on https://localhost:3000 using the trusted certificate
 *                     from office-addin-dev-certs, as Office hosts require.
 *  - `browser`      → plain HTTP with VITE_OFFICE_MOCK=1 (.env.browser); used by
 *                     `pnpm dev:web` and Playwright so the app runs outside Word.
 */

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const entry = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

interface HttpsServerOptions {
  ca: Buffer | string;
  cert: Buffer | string;
  key: Buffer | string;
}

/**
 * Loads the trusted localhost certificate created by `pnpm certs:install`.
 * Falls back to HTTP with a warning so browser-only workflows (and CI containers
 * without a trust store) still function; Word itself requires the HTTPS path.
 */
async function loadHttpsOptions(): Promise<HttpsServerOptions | undefined> {
  try {
    const mod = (await import('office-addin-dev-certs')) as
      | typeof import('office-addin-dev-certs')
      | { default: typeof import('office-addin-dev-certs') };
    const devCerts = 'default' in mod ? mod.default : mod;
    const { ca, cert, key } = await devCerts.getHttpsServerOptions();
    return { ca, cert, key };
  } catch (error) {
    console.warn(
      '[gretta] HTTPS dev certificate unavailable — serving over HTTP. ' +
        'Run "pnpm certs:install" before sideloading into Word.',
      error instanceof Error ? `(${error.message})` : '',
    );
    return undefined;
  }
}

export default defineConfig(async ({ command, mode }) => {
  const isBrowserMode = mode === 'browser';
  const https = command === 'serve' && !isBrowserMode ? await loadHttpsOptions() : undefined;

  return {
    root: rootDir,
    plugins: [react()],
    server: {
      port: 3000,
      strictPort: true,
      open: false,
      // Office webviews cache dev responses aggressively; never let them.
      headers: { 'Cache-Control': 'no-store' },
      ...(https ? { https } : {}),
    },
    preview: {
      port: 3000,
      strictPort: true,
      ...(https ? { https } : {}),
    },
    build: {
      target: 'es2020',
      outDir: 'dist',
      sourcemap: true,
      rollupOptions: {
        input: {
          taskpane: entry('taskpane.html'),
          commands: entry('commands.html'),
        },
      },
    },
  };
});
