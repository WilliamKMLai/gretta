/**
 * Migration tests (ADR-006, ADR-021). A migration runs against data written by
 * an older build, so the bar is: never throw, never lose a generated response,
 * and never invent one.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationsV1ToHistoryV2,
  settingsV1ToV2,
  settingsV2ToV3,
  settingsV3ToV4,
} from './migrations';

interface HistoryShape {
  records: {
    id: string;
    createdAt: string;
    prompt: string;
    response: string;
    model: string;
    outcome: string;
    stats?: unknown;
  }[];
}

const run = (data: unknown): HistoryShape => conversationsV1ToHistoryV2(data) as HistoryShape;

describe('settingsV1ToV2', () => {
  it('raises a context window the user never changed', () => {
    expect(settingsV1ToV2({ contextLength: 2048 })).toMatchObject({ contextLength: 4096 });
  });

  it('leaves a deliberately chosen context window alone', () => {
    expect(settingsV1ToV2({ contextLength: 8192 })).toMatchObject({ contextLength: 8192 });
    expect(settingsV1ToV2({ contextLength: 1024 })).toMatchObject({ contextLength: 1024 });
  });

  it('tags the default embedding model so it matches what Ollama reports', () => {
    expect(settingsV1ToV2({ kbDefaultEmbeddingModel: 'nomic-embed-text' })).toMatchObject({
      kbDefaultEmbeddingModel: 'nomic-embed-text:latest',
    });
  });

  it('leaves a deliberately chosen embedding model alone', () => {
    expect(settingsV1ToV2({ kbDefaultEmbeddingModel: 'mxbai-embed-large:latest' })).toMatchObject({
      kbDefaultEmbeddingModel: 'mxbai-embed-large:latest',
    });
  });

  it('preserves every other setting untouched', () => {
    const before = { ollamaUrl: 'http://x', temperature: 0.9, contextLength: 2048 };
    expect(settingsV1ToV2(before)).toEqual({
      ollamaUrl: 'http://x',
      temperature: 0.9,
      contextLength: 4096,
    });
  });

  it('passes a malformed payload through rather than throwing', () => {
    expect(settingsV1ToV2(null)).toBeNull();
    expect(settingsV1ToV2('nonsense')).toBe('nonsense');
  });
});

describe('conversationsV1ToHistoryV2', () => {
  it('flattens each user/assistant pair into one record', () => {
    const { records } = run({
      conversations: [
        {
          id: 'c1',
          title: 'Old thread',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:10:00.000Z',
          messages: [
            { id: 'm1', role: 'user', content: 'tidy this', createdAt: '2026-01-01T00:00:00.000Z' },
            {
              id: 'm2',
              role: 'assistant',
              content: 'Tidied.',
              createdAt: '2026-01-01T00:00:05.000Z',
              model: 'llama3',
              stats: { totalDurationMs: 1, evalCount: 2, promptEvalCount: 3, tokensPerSecond: 4 },
            },
          ],
        },
      ],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      prompt: 'tidy this',
      response: 'Tidied.',
      model: 'llama3',
      outcome: 'completed',
    });
    expect(records[0]?.stats).toEqual({
      totalDurationMs: 1,
      evalCount: 2,
      promptEvalCount: 3,
      tokensPerSecond: 4,
    });
  });

  it('splits a multi-turn thread into independent records', () => {
    const { records } = run({
      conversations: [
        {
          id: 'c1',
          messages: [
            { role: 'user', content: 'first', createdAt: '2026-01-01T00:00:00.000Z' },
            { role: 'assistant', content: 'one', createdAt: '2026-01-01T00:00:01.000Z' },
            { role: 'user', content: 'second', createdAt: '2026-01-01T00:00:02.000Z' },
            { role: 'assistant', content: 'two', createdAt: '2026-01-01T00:00:03.000Z' },
          ],
        },
      ],
    });
    expect(records.map((record) => [record.prompt, record.response])).toEqual([
      ['second', 'two'],
      ['first', 'one'],
    ]);
  });

  it('keeps a prompt that never got a reply', () => {
    const { records } = run({
      conversations: [
        {
          id: 'c1',
          messages: [
            { role: 'user', content: 'unanswered', createdAt: '2026-01-01T00:00:00.000Z' },
          ],
        },
      ],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ prompt: 'unanswered', response: '' });
  });

  it('keeps a reply whose prompt is missing rather than dropping generated text', () => {
    const { records } = run({
      conversations: [
        {
          id: 'c1',
          messages: [
            { role: 'assistant', content: 'orphan output', createdAt: '2026-01-01T00:00:00.000Z' },
          ],
        },
      ],
    });
    expect(records[0]).toMatchObject({ prompt: '', response: 'orphan output' });
  });

  it('orders every record newest-first across threads', () => {
    const { records } = run({
      conversations: [
        {
          id: 'old',
          messages: [
            { role: 'user', content: 'older', createdAt: '2026-01-01T00:00:00.000Z' },
            { role: 'assistant', content: 'a', createdAt: '2026-01-01T00:00:01.000Z' },
          ],
        },
        {
          id: 'new',
          messages: [
            { role: 'user', content: 'newer', createdAt: '2026-06-01T00:00:00.000Z' },
            { role: 'assistant', content: 'b', createdAt: '2026-06-01T00:00:01.000Z' },
          ],
        },
      ],
    });
    expect(records.map((record) => record.prompt)).toEqual(['newer', 'older']);
  });

  it('ignores system messages, which were never per-run', () => {
    const { records } = run({
      conversations: [
        {
          id: 'c1',
          messages: [
            { role: 'system', content: 'you are an editor', createdAt: '2026-01-01T00:00:00.000Z' },
            { role: 'user', content: 'go', createdAt: '2026-01-01T00:00:01.000Z' },
            { role: 'assistant', content: 'done', createdAt: '2026-01-01T00:00:02.000Z' },
          ],
        },
      ],
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.prompt).toBe('go');
  });

  it('survives malformed payloads without throwing', () => {
    expect(run(null).records).toEqual([]);
    expect(run({}).records).toEqual([]);
    expect(run({ conversations: 'nope' }).records).toEqual([]);
    expect(run({ conversations: [null, 42, { messages: 'no' }] }).records).toEqual([]);
    expect(run({ conversations: [{ messages: [{ role: 'user' }] }] })).toBeDefined();
  });

  it('defaults a missing model rather than dropping the record', () => {
    const { records } = run({
      conversations: [
        {
          id: 'c1',
          messages: [
            { role: 'user', content: 'q', createdAt: '2026-01-01T00:00:00.000Z' },
            { role: 'assistant', content: 'a', createdAt: '2026-01-01T00:00:01.000Z' },
          ],
        },
      ],
    });
    expect(records[0]?.model).toBe('unknown');
  });
});

describe('settingsV2ToV3', () => {
  it('carries a chosen embedding model across the rename', () => {
    expect(
      settingsV2ToV3({ defaultModel: 'x', kbDefaultEmbeddingModel: 'mxbai-embed-large' }),
    ).toEqual({
      defaultModel: 'x',
      defaultEmbeddingModel: 'mxbai-embed-large',
    });
  });

  it('drops the old key rather than leaving both alive', () => {
    // Two live names means every future reader must know which wins.
    expect(settingsV2ToV3({ kbDefaultEmbeddingModel: 'a' })).not.toHaveProperty(
      'kbDefaultEmbeddingModel',
    );
  });

  it('leaves a payload with no old key untouched', () => {
    expect(settingsV2ToV3({ defaultEmbeddingModel: 'a' })).toEqual({ defaultEmbeddingModel: 'a' });
  });

  it('drops a non-string value rather than persisting a bad setting', () => {
    expect(settingsV2ToV3({ kbDefaultEmbeddingModel: 42 })).toEqual({});
  });

  it('passes through anything that is not an object', () => {
    expect(settingsV2ToV3('nonsense')).toBe('nonsense');
  });
});

describe('settingsV3ToV4', () => {
  it('inserts the default citation-impact weight for a v3 payload', () => {
    expect(settingsV3ToV4({ ollamaUrl: 'http://x' })).toEqual({
      ollamaUrl: 'http://x',
      litCitationImpactWeight: 0.25,
    });
  });

  it('leaves a value already present untouched, even if the user set it to 0', () => {
    expect(settingsV3ToV4({ litCitationImpactWeight: 0 })).toEqual({
      litCitationImpactWeight: 0,
    });
  });

  it('passes through anything that is not an object', () => {
    expect(settingsV3ToV4('nonsense')).toBe('nonsense');
    expect(settingsV3ToV4(null)).toBeNull();
  });
});
