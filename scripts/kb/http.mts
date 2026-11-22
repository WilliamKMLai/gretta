/**
 * The companion's small HTTP plumbing (DECISIONS.md ADR-020).
 *
 * Extracted from `server.mts` rather than added to it: that file was already at
 * the 300-line limit before ADR-033's `/pick-folder` route, and these three
 * helpers are the part of it with no dependency on the registry, the store, or
 * any module-level state — which also makes them the part worth testing
 * directly, since `server.mts` starts listening at import and cannot be loaded
 * from a test at all.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Matches `http(s)://localhost`, `127.0.0.1`, or `[::1]`, with or without a port. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u;

/** Client-attributable HTTP error (`400` malformed input, `413` oversized body). */
export class HttpError extends Error {
  readonly status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Parses a comma-separated `GRETTA_KB_ORIGINS` env value into normalized origins. */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (raw === undefined || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().replace(/\/+$/u, ''))
      .filter((entry) => entry !== ''),
  );
}

/**
 * True when a request's `Origin` may talk to the companion.
 *
 * Missing `Origin` (CLI tools, Node probes) is allowed because browsers always
 * attach `Origin` on cross-origin requests; any browser `Origin` must be local
 * (`localhost`, `127.0.0.1`, `[::1]`) or explicitly listed in `extraOrigins`.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  extraOrigins?: ReadonlySet<string>,
): boolean {
  if (origin === undefined) return true;
  return LOOPBACK_ORIGIN.test(origin) || (extraOrigins?.has(origin) ?? false);
}

/**
 * Applies loopback-scoped CORS headers and reports whether the caller's
 * `Origin` is permitted. Never emits `*`: a trusted local dev CA otherwise lets
 * arbitrary websites read `/collections`, index host folders, or trigger
 * `/pick-folder` via the user's browser.
 */
export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  extraOrigins?: ReadonlySet<string>,
): boolean {
  const origin = req.headers.origin;
  const allowed = isAllowedOrigin(origin, extraOrigins);
  if (!allowed) return false;
  if (origin !== undefined) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** URI-decodes a route segment, mapping malformed `%` escapes to `HttpError(400)`. */
export function safeDecodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'malformed URL parameter');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads and parses a JSON object body, bounded by `maxBytes`.
 *
 * Enforces the byte ceiling as chunks arrive (destroying the request stream and
 * raising `413`), treats an empty body as `{}`, and rejects invalid or
 * non-object JSON (`null`, arrays, primitives) with `400`.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      req.destroy();
      throw new HttpError(413, 'request body too large');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return parsed;
}
