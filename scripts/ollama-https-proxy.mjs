#!/usr/bin/env node
/**
 * GRETTA — local HTTPS reverse proxy for Ollama (DECISIONS.md ADR-008).
 *
 * Why this exists: Word for Mac hosts the task pane in WKWebView, which blocks
 * requests from the HTTPS pane to http://localhost as mixed content (unlike
 * Chromium-based hosts, which treat loopback as potentially trustworthy). This
 * proxy terminates TLS with the same trusted development certificate the dev
 * server uses (created by `pnpm certs:install` via office-addin-dev-certs) and
 * forwards everything to the local Ollama daemon — preserving streamed NDJSON
 * bodies chunk by chunk and propagating client aborts so Ollama stops
 * generating when the user cancels.
 *
 * Usage:
 *   pnpm proxy           # https://localhost:11435  →  http://127.0.0.1:11434
 *
 * The TLS certificate auto-provisions through office-addin-dev-certs — the
 * same source the dev server uses — generating it when missing or expired, so
 * proxy/dev start order does not matter. On a machine that has never trusted
 * the dev CA, run `pnpm certs:install` once so Word's webview accepts it.
 *
 * Then set the GRETTA Ollama URL to https://localhost:11435 on the Mac.
 *
 * Environment overrides:
 *   GRETTA_PROXY_PORT   listen port            (default 11435)
 *   GRETTA_OLLAMA_URL   upstream Ollama URL    (default http://127.0.0.1:11434)
 *   GRETTA_CERT_DIR     certificate directory  (default ~/.office-addin-dev-certs)
 */
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer, request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const PORT = Number(process.env.GRETTA_PROXY_PORT ?? 11435);
const TARGET = new URL(process.env.GRETTA_OLLAMA_URL ?? 'http://127.0.0.1:11434');
const CERT_DIR = process.env.GRETTA_CERT_DIR ?? join(homedir(), '.office-addin-dev-certs');

const certPath = join(CERT_DIR, 'localhost.crt');
const keyPath = join(CERT_DIR, 'localhost.key');

process.on('uncaughtException', (error) => {
  console.error(`[gretta-proxy] Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

/**
 * TLS material. Preferred path: the office-addin-dev-certs API (the exact
 * mechanism the dev server uses), which GENERATES the certificate when it is
 * missing or expired — this is what removes the "dev must run first" ordering
 * bug. Fallback: raw files on disk; final: one-line guidance, clean exit.
 */
async function loadTlsOptions() {
  try {
    const mod = await import('office-addin-dev-certs');
    const devCerts = mod.default ?? mod;
    const { cert, key, ca } = await devCerts.getHttpsServerOptions();
    return ca ? { cert, key, ca } : { cert, key };
  } catch (error) {
    if (existsSync(certPath) && existsSync(keyPath)) {
      console.warn(
        '[gretta-proxy] office-addin-dev-certs unavailable; using the certificate files on disk.',
      );
      return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    }
    console.error('[gretta-proxy] Could not obtain the localhost dev certificate.');
    console.error(`[gretta-proxy] ${error instanceof Error ? error.message : String(error)}`);
    console.error('[gretta-proxy] Fix: run "pnpm certs:install" once, then start the proxy again.');
    process.exit(1);
  }
}

const tlsOptions = await loadTlsOptions();

const upstreamRequest = TARGET.protocol === 'https:' ? httpsRequest : httpRequest;
const targetPort =
  TARGET.port !== '' ? Number(TARGET.port) : TARGET.protocol === 'https:' ? 443 : 80;

const server = createServer(tlsOptions, (req, res) => {
  const upstream = upstreamRequest(
    {
      hostname: TARGET.hostname,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: TARGET.host },
    },
    (upstreamRes) => {
      // Let Node re-chunk the piped body itself; forwarding the upstream
      // transfer-encoding header alongside a pipe would double-encode it.
      const headers = { ...upstreamRes.headers };
      delete headers['transfer-encoding'];
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res); // streams NDJSON chunks through untouched
    },
  );

  upstream.on('error', (error) => {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : error.message;
    console.error(
      `[gretta-proxy] ${req.method ?? '?'} ${req.url ?? '?'} → upstream error: ${code}`,
    );
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(
      JSON.stringify({
        error: `gretta-proxy: Ollama at ${TARGET.origin} is unreachable (${code}). Is "ollama serve" running?`,
      }),
    );
  });

  // Propagate client disconnects/aborts upstream so Ollama stops generating
  // — this is the cancellation path (ARCHITECTURE.md §9). Destroying an
  // already-finished upstream request is a harmless no-op.
  res.on('close', () => {
    upstream.destroy();
  });
  req.on('error', () => {
    upstream.destroy();
  });

  req.pipe(upstream);
});

server.on('error', (error) => {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : error.message;
  if (code === 'EADDRINUSE') {
    console.error(`[gretta-proxy] Port ${String(PORT)} is already in use.`);
    console.error('[gretta-proxy] Stop the other process or set GRETTA_PROXY_PORT.');
  } else {
    console.error(`[gretta-proxy] Failed to start: ${code}`);
  }
  process.exit(1);
});

// Long generations are normal: a large local model can stream for many
// minutes. Node would otherwise cut the request at its 300 s default
// `requestTimeout` and the pane would report the connection as interrupted
// mid-generation (ADR-023). Timeouts here measure nothing useful — the client
// already enforces an idle timeout and the user can stop at any time.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.on('connection', (socket) => {
  socket.setTimeout(0);
});

server.listen(PORT, () => {
  console.log(`[gretta-proxy] https://localhost:${String(PORT)}  →  ${TARGET.origin}`);
  console.log('[gretta-proxy] Set the GRETTA Ollama URL to the https address above.');
  console.log('[gretta-proxy] Press Ctrl+C to stop.');
});
