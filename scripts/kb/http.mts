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

/** Matches `http(s)://localhost` or `127.0.0.1`, with or without a port. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u;

/**
 * Loopback-only permissive CORS: reflect a localhost origin, else allow all.
 *
 * The wildcard fallback looks lax and is not the security boundary — the
 * companion binds to loopback, so anything that can reach it is already running
 * as this user. Reflecting the specific origin when it is recognisably local is
 * what lets credentialed requests work from the dev server and the Word webview
 * alike, both of which present origins this cannot enumerate ahead of time.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allow = origin !== undefined && LOOPBACK_ORIGIN.test(origin);
  res.setHeader('Access-Control-Allow-Origin', allow ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Reads and parses a JSON body, bounded by `maxBytes`.
 *
 * The bound is enforced as chunks arrive rather than after buffering, so an
 * oversized body is rejected without ever being held in memory. An empty body
 * is `{}` rather than a parse error: several routes take no fields and should
 * not require callers to send `{}` explicitly.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}
