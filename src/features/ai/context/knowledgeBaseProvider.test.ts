/**
 * KB provider tests. Retrieval is best-effort context (ADR-020): every failure
 * path must yield "no context", never an exception into generation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setServices } from '../../../app/services';
import type { KnowledgeBaseClient } from '../../../services/knowledgebase';
import type { RetrievedChunk } from '../../../types/knowledgebase';
import { createKnowledgeBaseProvider, formatChunks } from './knowledgeBaseProvider';

const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  collectionId: 'refs',
  source: 'paper.pdf',
  locator: { page: 3, paragraph: null },
  text: 'Chlorophyll reflects green light.',
  score: 0.7,
  ...over,
});

function stubKb(query: KnowledgeBaseClient['query']): void {
  const kb: KnowledgeBaseClient = {
    health: vi.fn(),
    listCollections: vi.fn(),
    upsertCollection: vi.fn(),
    deleteCollection: vi.fn(),
    reindexCollection: vi.fn(),
    query,
  };
  setServices({ kb });
}

const request = { query: 'why is it green', vars: {}, signal: new AbortController().signal };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatChunks', () => {
  it('cites pages, paragraphs, and bare files distinctly', () => {
    const text = formatChunks([
      chunk(),
      chunk({ source: 'notes.md', locator: { page: null, paragraph: 2 } }),
      chunk({ source: 'plain.txt', locator: { page: null, paragraph: null } }),
    ]);
    expect(text).toContain('[1] paper.pdf, p. 3');
    expect(text).toContain('[2] notes.md, ¶2');
    expect(text).toContain('[3] plain.txt\n');
  });
});

describe('createKnowledgeBaseProvider', () => {
  it('returns a labeled block with provenance when chunks come back', async () => {
    stubKb(() => Promise.resolve([chunk()]));
    const block = await createKnowledgeBaseProvider({
      enabled: true,
      collectionIds: ['refs'],
    }).provide(request);
    expect(block?.providerId).toBe('knowledge-base');
    expect(block?.text).toContain('paper.pdf, p. 3');
    expect(block?.sources).toHaveLength(1);
  });

  it('contributes nothing when the feature is disabled', async () => {
    const query = vi.fn<KnowledgeBaseClient['query']>(() => Promise.resolve([]));
    stubKb(query);
    const block = await createKnowledgeBaseProvider({
      enabled: false,
      collectionIds: ['refs'],
    }).provide(request);
    expect(block).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('contributes nothing when the document is bound to no collection', async () => {
    const query = vi.fn<KnowledgeBaseClient['query']>(() => Promise.resolve([]));
    stubKb(query);
    const block = await createKnowledgeBaseProvider({
      enabled: true,
      collectionIds: [],
    }).provide(request);
    expect(block).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('contributes nothing for an empty prompt', async () => {
    stubKb(() => Promise.resolve([chunk()]));
    const block = await createKnowledgeBaseProvider({
      enabled: true,
      collectionIds: ['refs'],
    }).provide({ ...request, query: '   ' });
    expect(block).toBeNull();
  });

  it('swallows a companion failure rather than breaking generation', async () => {
    stubKb(() => Promise.reject(new Error('companion offline')));
    await expect(
      createKnowledgeBaseProvider({ enabled: true, collectionIds: ['refs'] }).provide(request),
    ).resolves.toBeNull();
  });

  it('contributes nothing when the index returns no matches', async () => {
    stubKb(() => Promise.resolve([]));
    await expect(
      createKnowledgeBaseProvider({ enabled: true, collectionIds: ['refs'] }).provide(request),
    ).resolves.toBeNull();
  });

  it('scopes the query to exactly the bound collections', async () => {
    const query = vi.fn<KnowledgeBaseClient['query']>(() => Promise.resolve([chunk()]));
    stubKb(query);
    await createKnowledgeBaseProvider({
      enabled: true,
      collectionIds: ['protocols', 'refs'],
    }).provide(request);
    expect(query.mock.calls[0]?.[1]).toEqual(['protocols', 'refs']);
  });
});
