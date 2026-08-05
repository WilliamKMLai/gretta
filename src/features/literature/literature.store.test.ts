/** Literature store tests (ADR-028): the review gate expressed as state. */
import { beforeEach, describe, expect, it } from 'vitest';
import { useLiteratureStore } from './literature.store';

const initial = useLiteratureStore.getState();

beforeEach(() => {
  useLiteratureStore.setState(initial, true);
});

describe('useLiteratureStore', () => {
  it('starts idle with nothing captured or drafted', () => {
    const state = useLiteratureStore.getState();
    expect(state.phase).toBe('idle');
    expect(state.passage).toBe('');
    expect(state.draft).toBe('');
    expect(state.results).toEqual([]);
  });

  it('keeps the passage separate from the draft', () => {
    // Different rules: the passage never leaves the machine, the draft is the
    // only text ever transmitted.
    useLiteratureStore.getState().setPassage('a sentence from the manuscript');
    useLiteratureStore.getState().setDraft('keywords only');
    expect(useLiteratureStore.getState().passage).toBe('a sentence from the manuscript');
    expect(useLiteratureStore.getState().draft).toBe('keywords only');
  });

  it('does not clear results while the query is being reworded', () => {
    useLiteratureStore.getState().setResults([], 'semantic', 0, null, [], []);
    useLiteratureStore.getState().setDraft('new wording');
    expect(useLiteratureStore.getState().ranking).toBe('semantic');
    expect(useLiteratureStore.getState().phase).toBe('done');
  });

  it('moves to the error phase when an error is set', () => {
    useLiteratureStore.getState().setError('nope');
    expect(useLiteratureStore.getState().phase).toBe('error');
  });

  it('clearing an error does not disturb the phase', () => {
    // The bug this guards: the opening sequence of every operation is
    // `setPhase(busy); setError(null)`. When clearing an error also set the
    // phase, the busy state was erased on the line after it was set, so the
    // spinner never appeared and a working search looked like a dead button.
    useLiteratureStore.getState().setPhase('searching');
    useLiteratureStore.getState().setError(null);
    expect(useLiteratureStore.getState().phase).toBe('searching');
    expect(useLiteratureStore.getState().error).toBeNull();
  });

  it('records why ranking fell back, so a fallback is not mistaken for a fault', () => {
    useLiteratureStore.getState().setResults([], 'lexical', 0, 'model not pulled', [], []);
    expect(useLiteratureStore.getState().rankingNote).toBe('model not pulled');
  });

  it('reset returns everything to the initial state', () => {
    useLiteratureStore.getState().setPassage('x');
    useLiteratureStore.getState().setDraft('y');
    useLiteratureStore.getState().reset();
    expect(useLiteratureStore.getState().passage).toBe('');
    expect(useLiteratureStore.getState().draft).toBe('');
  });

  it('reset also clears results, so clearing the literature cache empties the panel', () => {
    // ADR-028's clear control deletes the on-disk cache and calls reset() so
    // the last query's results don't linger on screen after the user asked to
    // clear their search history — a stale results list would say one thing
    // and show another.
    useLiteratureStore
      .getState()
      .setResults(
        [],
        'semantic',
        2,
        'fell back to lexical',
        [{ source: 'PubMed', query: 'q' }],
        [{ source: 'PubMed', message: 'HTTP 500' }],
      );
    useLiteratureStore.getState().reset();
    const state = useLiteratureStore.getState();
    expect(state.results).toEqual([]);
    expect(state.ranking).toBe('source-order');
    expect(state.hiddenCount).toBe(0);
    expect(state.rankingNote).toBeNull();
    expect(state.sentQueries).toEqual([]);
    expect(state.failedSources).toEqual([]);
    expect(state.phase).toBe('idle');
  });
});
