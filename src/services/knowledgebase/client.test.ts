/**
 * KB client tests — mocked at the transport seam (ARCHITECTURE.md §14), so no
 * network and no companion are involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { KbError } from '../../types/errors';
import { createKnowledgeBaseClient } from './client';
import type { HttpTransport } from './client.types';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const collection = {
  id: 'refs',
  name: 'Refs',
  folders: ['/tmp/refs'],
  embeddingModel: 'nomic-embed-text',
  phase: 'ready',
  fileCount: 2,
  chunkCount: 40,
  maxChunks: 30_000,
  capacityPct: 0,
  overCapacity: false,
  skipped: [],
  lastIndexedAt: '2026-01-01T00:00:00.000Z',
  message: null,
};

const client = (transport: HttpTransport) =>
  createKnowledgeBaseClient({ baseUrl: 'https://localhost:11436', transport });

describe('createKnowledgeBaseClient', () => {
  it('parses health', async () => {
    const transport = vi.fn<HttpTransport>(() =>
      Promise.resolve(json({ name: 'gretta-kb', version: '1.0.0', ok: true })),
    );
    await expect(client(transport).health()).resolves.toEqual({
      name: 'gretta-kb',
      version: '1.0.0',
      ok: true,
    });
    expect(transport.mock.calls[0]?.[0]).toBe('https://localhost:11436/health');
  });

  it('lists collections including the capacity fields', async () => {
    const transport: HttpTransport = () => Promise.resolve(json({ collections: [collection] }));
    const [first] = await client(transport).listCollections();
    expect(first).toMatchObject({ id: 'refs', chunkCount: 40, maxChunks: 30_000 });
  });

  it('sends the collection ids on query and returns provenance', async () => {
    const transport = vi.fn<HttpTransport>(() =>
      Promise.resolve(
        json({
          chunks: [
            {
              collectionId: 'refs',
              source: 'paper.pdf',
              locator: { page: 4, paragraph: null },
              text: 'excerpt',
              score: 0.8,
            },
          ],
        }),
      ),
    );
    const chunks = await client(transport).query('why', ['refs'], 3);
    expect(chunks[0]).toMatchObject({ source: 'paper.pdf', locator: { page: 4 } });
    const sentBody = transport.mock.calls[0]?.[1].body;
    expect(JSON.parse(typeof sentBody === 'string' ? sentBody : '{}')).toEqual({
      query: 'why',
      collectionIds: ['refs'],
      k: 3,
    });
  });

  it('short-circuits a query with no bound collections (no request at all)', async () => {
    const transport = vi.fn<HttpTransport>(() => Promise.resolve(json({ chunks: [] })));
    await expect(client(transport).query('why', [], undefined)).resolves.toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('maps a dead companion to KbError("offline")', async () => {
    const transport: HttpTransport = () => Promise.reject(new TypeError('fetch failed'));
    await expect(client(transport).health()).rejects.toMatchObject({
      name: 'KbError',
      kind: 'offline',
    });
  });

  it('surfaces the companion error body on a failed status', async () => {
    const transport: HttpTransport = () =>
      Promise.resolve(json({ error: 'no such collection' }, 404));
    await expect(client(transport).deleteCollection('ghost')).rejects.toMatchObject({
      kind: 'http',
      message: 'no such collection',
      code: '404',
    });
  });

  it('maps an unexpected payload shape to invalid-response, never a ZodError', async () => {
    const transport: HttpTransport = () => Promise.resolve(json({ collections: 'nope' }));
    const error = await client(transport)
      .listCollections()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(KbError);
    expect((error as KbError).kind).toBe('invalid-response');
  });
});
