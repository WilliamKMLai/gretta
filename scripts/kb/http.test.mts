/**
 * Companion HTTP plumbing tests (ADR-020).
 *
 * These could not exist while the helpers lived in `server.mts`: that module
 * creates a server and starts listening at import, so it cannot be loaded from
 * a test at all. Extracting them for ADR-033's route made them reachable.
 */
import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { applyCors, readJsonBody, sendJson } from './http.mts';

/** Captures header/body writes without a socket. */
function fakeResponse(): ServerResponse & {
  headers: Record<string, unknown>;
  status: number | null;
  body: string;
} {
  const headers: Record<string, unknown> = {};
  const res = {
    headers,
    status: null as number | null,
    body: '',
    setHeader(name: string, value: unknown) {
      headers[name] = value;
    },
    writeHead(status: number, extra?: Record<string, string>) {
      res.status = status;
      Object.assign(headers, extra ?? {});
      return res;
    },
    end(chunk?: string) {
      res.body = chunk ?? '';
      return res;
    },
  };
  return res as unknown as ServerResponse & {
    headers: Record<string, unknown>;
    status: number | null;
    body: string;
  };
}

function request(body: string, origin?: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage;
  Object.defineProperty(stream, 'headers', {
    value: origin === undefined ? {} : { origin },
  });
  return stream;
}

describe('applyCors', () => {
  it.each([
    'http://localhost',
    'http://localhost:3000',
    'https://localhost:3000',
    'http://127.0.0.1:11436',
  ])('reflects the loopback origin %s', (origin: string) => {
    const res = fakeResponse();
    applyCors(request('', origin), res);
    expect(res.headers['Access-Control-Allow-Origin']).toBe(origin);
  });

  it.each(['https://evil.example', 'http://localhost.evil.example', 'http://notlocalhost'])(
    'does not reflect %s',
    (origin: string) => {
      // Falls back to the wildcard rather than echoing an arbitrary origin.
      // The wildcard is not the security boundary here — binding to loopback
      // is — but echoing a caller-controlled origin would be gratuitous.
      const res = fakeResponse();
      applyCors(request('', origin), res);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    },
  );

  it('falls back to the wildcard when there is no Origin header at all', () => {
    const res = fakeResponse();
    applyCors(request(''), res);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('sendJson', () => {
  it('writes the status, the content type, and the serialized body', () => {
    const res = fakeResponse();
    sendJson(res, 202, { ok: true });
    expect(res.status).toBe(202);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(res.body).toBe('{"ok":true}');
  });
});

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    expect(await readJsonBody(request('{"id":"refs"}'), 1024)).toEqual({ id: 'refs' });
  });

  it('reads an empty body as {}, so routes taking no fields need no payload', async () => {
    expect(await readJsonBody(request(''), 1024)).toEqual({});
  });

  it('rejects an oversized body rather than buffering it', async () => {
    await expect(readJsonBody(request('x'.repeat(2048)), 16)).rejects.toThrow(/too large/u);
  });

  it('propagates a parse failure rather than returning a half-understood object', async () => {
    await expect(readJsonBody(request('{not json'), 1024)).rejects.toThrow();
  });
});
