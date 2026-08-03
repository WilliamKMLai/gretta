import { describe, expect, it } from 'vitest';
import type { ContextBlock, ContextProvider, ContextRequest } from './provider';
import { assembleContextText, collectSources, runContextProviders } from './provider';

const request: ContextRequest = { query: 'q', vars: {}, signal: new AbortController().signal };

function provider(id: string, block: ContextBlock | null, delayMs = 0): ContextProvider {
  return {
    id,
    provide: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(block);
        }, delayMs);
      }),
  };
}

const block = (id: string, text: string): ContextBlock => ({
  providerId: id,
  label: id,
  text,
  sources: [
    {
      collectionId: id,
      source: `${id}.md`,
      locator: { page: null, paragraph: 1 },
      text,
      score: 0.9,
    },
  ],
});

describe('runContextProviders', () => {
  it('returns [] with no providers', async () => {
    expect(await runContextProviders([], request)).toEqual([]);
  });

  it('drops null and empty-text contributions', async () => {
    const blocks = await runContextProviders(
      [provider('a', null), provider('b', block('b', '   ')), provider('c', block('c', 'keep'))],
      request,
    );
    expect(blocks.map((b) => b.providerId)).toEqual(['c']);
  });

  it('preserves provider order regardless of resolution order', async () => {
    const blocks = await runContextProviders(
      [provider('slow', block('slow', 'x'), 20), provider('fast', block('fast', 'y'), 0)],
      request,
    );
    expect(blocks.map((b) => b.providerId)).toEqual(['slow', 'fast']);
  });

  it('drops providers that exceed the timeout', async () => {
    const blocks = await runContextProviders(
      [provider('late', block('late', 'x'), 50), provider('ok', block('ok', 'y'), 0)],
      request,
      10,
    );
    expect(blocks.map((b) => b.providerId)).toEqual(['ok']);
  });

  it('drops a provider that throws without failing the batch', async () => {
    const thrower: ContextProvider = { id: 'boom', provide: () => Promise.reject(new Error('x')) };
    const blocks = await runContextProviders([thrower, provider('ok', block('ok', 'y'))], request);
    expect(blocks.map((b) => b.providerId)).toEqual(['ok']);
  });
});

describe('assembleContextText / collectSources', () => {
  it('labels and joins blocks and flattens provenance', () => {
    const blocks = [block('kb', 'chunk one'), block('web', 'chunk two')];
    const text = assembleContextText(blocks);
    expect(text).toContain('--- kb ---');
    expect(text).toContain('chunk one');
    expect(text).toContain('--- web ---');
    expect(collectSources(blocks)).toHaveLength(2);
  });
});
