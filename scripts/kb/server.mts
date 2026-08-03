#!/usr/bin/env node
/**
 * GRETTA — local knowledge-base companion (DECISIONS.md ADR-020).
 *
 * The Word task pane runs in a sandboxed webview with no filesystem access, so
 * indexing folders of documents for RAG happens here, in a small local process
 * the pane talks to over HTTP — a sibling to the Ollama HTTPS proxy (ADR-008).
 * This process owns folder scanning, parsing, chunking, embedding via Ollama,
 * durable vector storage, and a top-k query API scoped by collection.
 *
 * Startup sequencing (learning from the proxy's cert-ordering bug): TLS
 * self-provisions through office-addin-dev-certs — the same mechanism the dev
 * server and proxy use — so companion/dev start order is irrelevant; then a
 * cert-file fallback, then a friendly exit. `GRETTA_KB_INSECURE=1` serves
 * plain HTTP on loopback for Chromium hosts (Windows/web) and CI. The data
 * directory is created on boot, and Ollama is OPTIONAL at boot: every route
 * answers immediately, and if embeddings are unreachable the affected
 * collection reports `ollama-unreachable` and retries — the companion never
 * crashes because a daemon is missing.
 *
 * API
 *   GET    /health
 *   GET    /collections
 *   POST   /collections                    upsert (id, name, folders[], model)
 *   DELETE /collections/:id
 *   POST   /collections/:id/reindex        { full?: boolean }
 *   GET    /collections/:id/status/stream  NDJSON progress
 *   POST   /query                          { query, collectionIds[], k? }
 *
 * Usage: `pnpm kb` (https://localhost:11436) — see docs/KNOWLEDGE-BASE.md.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { CollectionConfig, QueryDefaults } from '../../src/types/knowledgebase';
import { encodeProgress } from './progress.mts';
import { CollectionRegistry } from './registry.mts';
import { SqliteStore } from './store.sqlite.mts';

/** Reads an env var, treating an empty value as unset (an empty path is not a path). */
function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

const VERSION = '1.0.0';
const PORT = Number(env('GRETTA_KB_PORT', '11436'));
const DATA_DIR = env('GRETTA_KB_DIR', join(homedir(), '.gretta'));
const OLLAMA_URL = env('GRETTA_OLLAMA_URL', 'http://127.0.0.1:11434');
const CERT_DIR = env('GRETTA_KB_CERT_DIR', join(homedir(), '.office-addin-dev-certs'));
const INSECURE = process.env.GRETTA_KB_INSECURE === '1';
/** Logs each retrieval so "did the pane actually ask for chunks?" is answerable. */
const VERBOSE = process.env.GRETTA_KB_VERBOSE === '1';
const MAX_BODY_BYTES = 1_000_000;

const defaults: QueryDefaults = {
  topK: Number(env('GRETTA_KB_TOP_K', '5')),
  minScore: Number(env('GRETTA_KB_MIN_SCORE', '0.2')),
};

process.on('uncaughtException', (error) => {
  console.error(`[gretta-kb] Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

/** Creates the data directory — depends on no other service having run. */
function provisionDataDir(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, 'knowledge-base.sqlite3');
  console.log(`[gretta-kb] Index: ${file}`);
  return file;
}

/** TLS options, self-provisioning like the proxy so start order is irrelevant. */
async function loadTlsOptions(): Promise<{ cert: Buffer | string; key: Buffer | string }> {
  try {
    // The package is CJS: depending on interop it may arrive bare or under
    // `.default`, so narrow from unknown rather than asserting either shape.
    const imported: unknown = await import('office-addin-dev-certs');
    const wrapper = imported as { default?: unknown };
    const devCerts = (wrapper.default ?? imported) as {
      getHttpsServerOptions: () => Promise<{ cert: Buffer | string; key: Buffer | string }>;
    };
    const { cert, key } = await devCerts.getHttpsServerOptions();
    return { cert, key };
  } catch (error) {
    const certPath = join(CERT_DIR, 'localhost.crt');
    const keyPath = join(CERT_DIR, 'localhost.key');
    if (existsSync(certPath) && existsSync(keyPath)) {
      console.warn('[gretta-kb] office-addin-dev-certs unavailable; using cert files on disk.');
      return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    }
    console.error('[gretta-kb] Could not obtain the localhost dev certificate.');
    console.error(`[gretta-kb] ${error instanceof Error ? error.message : String(error)}`);
    console.error('[gretta-kb] Fix: run "pnpm certs:install", or set GRETTA_KB_INSECURE=1.');
    process.exit(1);
  }
}

const store = new SqliteStore(provisionDataDir());
const registry = new CollectionRegistry(store, defaults, OLLAMA_URL);

/** Loopback-only permissive CORS: reflect a localhost origin, else allow all. */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allow =
    origin !== undefined && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin);
  res.setHeader('Access-Control-Allow-Origin', allow ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}

/** Streams a collection's NDJSON progress until the client disconnects. */
function streamStatus(id: string, res: ServerResponse): void {
  const indexer = registry.get(id);
  if (indexer === null) {
    sendJson(res, 404, { error: `no collection "${id}"` });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  res.write(encodeProgress({ type: 'phase', phase: indexer.status().phase }));
  const unsubscribe = registry.onProgress(id, (event) => {
    res.write(encodeProgress(event));
  });
  res.on('close', () => unsubscribe?.());
}

function parseConfig(body: unknown): CollectionConfig | string {
  const raw = body as Partial<CollectionConfig> & { folder?: string };
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
  if (id === null) return '"id" (string) is required';
  const folders = Array.isArray(raw.folders)
    ? raw.folders.filter((folder): folder is string => typeof folder === 'string')
    : typeof raw.folder === 'string'
      ? [raw.folder]
      : [];
  return {
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
    folders,
    embeddingModel:
      typeof raw.embeddingModel === 'string' && raw.embeddingModel !== ''
        ? raw.embeddingModel
        : env('GRETTA_KB_EMBED_MODEL', 'nomic-embed-text:latest'),
  };
}

const COLLECTION_RE = /^\/collections\/([^/]+)$/u;
const STREAM_RE = /^\/collections\/([^/]+)\/status\/stream$/u;
const REINDEX_RE = /^\/collections\/([^/]+)\/reindex$/u;

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(req, res);
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method === 'GET' && path === '/health') {
    // `dataDir` is reported so the pane can say where the index actually lives.
    // It sits in the user's home directory, not the repository, which means
    // deleting and reinstalling the project leaves every collection intact —
    // surprising enough that it should be visible rather than discovered.
    sendJson(res, 200, { name: 'gretta-kb', version: VERSION, ok: true, dataDir: DATA_DIR });
    return;
  }
  if (method === 'GET' && path === '/collections') {
    sendJson(res, 200, { collections: registry.list() });
    return;
  }
  if (method === 'POST' && path === '/collections') {
    const config = parseConfig(await readJsonBody(req));
    if (typeof config === 'string') {
      sendJson(res, 400, { error: config });
      return;
    }
    // Respond as soon as the collection exists; indexing continues in the
    // background and is observable through the NDJSON status stream.
    const pending = registry.upsert(config);
    pending.catch((error: unknown) => {
      console.error(`[gretta-kb] Index failed: ${String(error)}`);
    });
    sendJson(res, 202, registry.get(config.id)?.status() ?? { id: config.id });
    return;
  }
  const reindex = REINDEX_RE.exec(path);
  if (method === 'POST' && reindex !== null) {
    const indexer = registry.get(reindex[1] ?? '');
    if (indexer === null) {
      sendJson(res, 404, { error: 'no such collection' });
      return;
    }
    const body = (await readJsonBody(req)) as { full?: unknown };
    void indexer.reindex(body.full === true);
    sendJson(res, 202, indexer.status());
    return;
  }
  const stream = STREAM_RE.exec(path);
  if (method === 'GET' && stream !== null) {
    streamStatus(stream[1] ?? '', res);
    return;
  }
  const collection = COLLECTION_RE.exec(path);
  if (method === 'DELETE' && collection !== null) {
    const ok = registry.delete(collection[1] ?? '');
    sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: 'no such collection' });
    return;
  }
  if (method === 'POST' && path === '/query') {
    const body = (await readJsonBody(req)) as {
      query?: unknown;
      collectionIds?: unknown;
      k?: unknown;
    };
    if (typeof body.query !== 'string') {
      sendJson(res, 400, { error: '"query" (string) is required' });
      return;
    }
    const ids = Array.isArray(body.collectionIds)
      ? body.collectionIds.filter((id): id is string => typeof id === 'string')
      : [];
    const k = typeof body.k === 'number' ? body.k : undefined;
    const chunks = await registry.query(ids, body.query, k);
    if (VERBOSE) {
      const preview = body.query.replace(/\s+/gu, ' ').slice(0, 60);
      const from = ids.length === 0 ? 'no collections' : ids.join(', ');
      console.log(
        `[gretta-kb] query "${preview}" → ${String(chunks.length)} chunk(s) from ${from}` +
          (chunks[0] === undefined
            ? ''
            : ` · best ${chunks[0].source} ${chunks[0].score.toFixed(3)}`),
      );
    }
    sendJson(res, 200, { chunks });
    return;
  }
  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}

const handler = (req: IncomingMessage, res: ServerResponse): void => {
  route(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'internal error';
    if (!res.headersSent) sendJson(res, 500, { error: `gretta-kb: ${message}` });
    else res.end();
  });
};

const server = INSECURE
  ? createHttpServer(handler)
  : createHttpsServer(await loadTlsOptions(), handler);

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[gretta-kb] Port ${String(PORT)} is already in use.`);
    console.error('[gretta-kb] Stop the other process or set GRETTA_KB_PORT.');
  } else {
    console.error(`[gretta-kb] Failed to start: ${error.code ?? error.message}`);
  }
  process.exit(1);
});

function shutdown(): void {
  console.log('\n[gretta-kb] Shutting down…');
  registry.closeAll();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 400);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  const scheme = INSECURE ? 'http' : 'https';
  console.log(`[gretta-kb] ${scheme}://localhost:${String(PORT)}  (Ollama: ${OLLAMA_URL})`);
  const collections = registry.list();
  if (collections.length === 0) {
    console.log('[gretta-kb] No collections yet — add one in the pane’s Knowledge base panel.');
  } else {
    for (const c of collections) {
      console.log(`[gretta-kb] "${c.name}" · ${String(c.chunkCount)} chunks · ${c.embeddingModel}`);
    }
    registry.resumeAll();
  }
  if (VERBOSE) console.log('[gretta-kb] Verbose: retrieval queries will be logged.');
  console.log('[gretta-kb] Press Ctrl+C to stop.');
});
