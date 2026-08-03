/**
 * Restoring a past run into the response pane (ADR-021). The pane renders only
 * from this store, so opening a record must load it here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { GenerationRecord } from '../../types/domain';
import { useStreamStore } from './stream.store';

const record: GenerationRecord = {
  id: 'r1',
  createdAt: '2026-07-20T10:00:00.000Z',
  prompt: 'tighten this',
  response: 'Tightened text.',
  model: 'llama3',
  outcome: 'completed',
  templateId: 'tpl-clarity',
  stats: { totalDurationMs: 10, evalCount: 5, promptEvalCount: 2, tokensPerSecond: 3 },
  sources: [
    {
      collectionId: 'refs',
      source: 'buffer.txt',
      locator: { page: null, paragraph: 1 },
      text: 'excerpt',
      score: 0.4,
    },
  ],
};

beforeEach(() => {
  useStreamStore.getState().reset();
});

describe('useStreamStore.restore', () => {
  it('shows the record’s response, stats, and sources', () => {
    useStreamStore.getState().restore(record);
    const state = useStreamStore.getState();
    expect(state.text).toBe('Tightened text.');
    expect(state.status).toBe('completed');
    expect(state.stats?.evalCount).toBe(5);
    expect(state.sources).toHaveLength(1);
    expect(state.request?.model).toBe('llama3');
  });

  it('clears any earlier error', () => {
    useStreamStore.getState().restore({ ...record, response: 'x' });
    expect(useStreamStore.getState().error).toBeNull();
  });

  it('marks a non-completed run as such rather than claiming success', () => {
    useStreamStore.getState().restore({ ...record, outcome: 'cancelled' });
    expect(useStreamStore.getState().status).toBe('cancelled');
  });

  it('never interrupts a live generation', () => {
    useStreamStore.getState().start({ model: 'llama3', promptId: null });
    useStreamStore.getState().appendToken('live');
    useStreamStore.getState().restore(record);
    expect(useStreamStore.getState().text).toBe('live');
  });

  it('reset clears a restored record', () => {
    useStreamStore.getState().restore(record);
    useStreamStore.getState().reset();
    expect(useStreamStore.getState().text).toBe('');
    expect(useStreamStore.getState().sources).toEqual([]);
  });
});
