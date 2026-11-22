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
import {
  HttpError,
  applyCors,
  isAllowedOrigin,
  parseAllowedOrigins,
  readJsonBody,
  safeDecodeParam,
  sendJson,
} from './http.mts';

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

describe('applyCors and origin checks', () => {
  it.each([
    'http://localhost',
    'http://localhost:3000',
    'https://localhost:3000',
    'http://127.0.0.1:11436',
    'http://[::1]:3000',
    'https://[::1]',
  ])('reflects the loopback origin %s with Vary: Origin', (origin: string) => {
    const res = fakeResponse();
    expect(applyCors(request('', origin), res)).toBe(true);
    expect(res.headers['Access-Control-Allow-Origin']).toBe(origin);
    expect(res.headers.Vary).toBe('Origin');
  });

  it('allows explicitly configured GRETTA_KB_ORIGINS entries', () => {
    const allowed = parseAllowedOrigins('https://addin.example.edu/, https://lab.example.org');
    const res = fakeResponse();
    expect(applyCors(request('', 'https://addin.example.edu'), res, allowed)).toBe(true);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://addin.example.edu');
    expect(isAllowedOrigin('https://other.example.com', allowed)).toBe(false);
  });

  it.each([
    'https://evil.example',
    'http://localhost.evil.example',
    'http://notlocalhost',
    'null',
    'file://',
  ])('rejects untrusted cross-origin %s without wildcard CORS', (origin: string) => {
    const res = fakeResponse();
    expect(applyCors(request('', origin), res)).toBe(false);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('allows Origin-less requests (CLI / Node probes) without emitting a wildcard origin', () => {
    const res = fakeResponse();
    expect(applyCors(request(''), res)).toBe(true);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('safeDecodeParam', () => {
  it('decodes percent-encoded route parameters', () => {
    expect(safeDecodeParam('my%20refs%2F2026')).toBe('my refs/2026');
  });

  it('maps malformed percent escapes to HttpError(400)', () => {
    expect(() => safeDecodeParam('%ZZ')).toThrow(HttpError);
    try {
      safeDecodeParam('%ZZ');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
    }
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
  it('parses a JSON object body', async () => {
    expect(await readJsonBody(request('{"id":"refs"}'), 1024)).toEqual({ id: 'refs' });
  });

  it('reads an empty body as {}, so routes taking no fields need no payload', async () => {
    expect(await readJsonBody(request(''), 1024)).toEqual({});
  });

  it('rejects an oversized body with 413 and destroys the stream', async () => {
    const req = request('x'.repeat(2048));
    await expect(readJsonBody(req, 16)).rejects.toMatchObject({
      name: 'HttpError',
      status: 413,
    });
    expect(req.destroyed).toBe(true);
  });

  it('rejects malformed JSON with HttpError(400)', async () => {
    await expect(readJsonBody(request('{not json'), 1024)).rejects.toMatchObject({
      name: 'HttpError',
      status: 400,
    });
  });

  it.each(['null', '[]', '123', '"hello"'])(
    'rejects non-object JSON payload %s with HttpError(400)',
    async (payload: string) => {
      await expect(readJsonBody(request(payload), 1024)).rejects.toMatchObject({
        name: 'HttpError',
        status: 400,
      });
    },
  );
});
