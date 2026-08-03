import { OllamaError } from '../../types/errors';
import type { GenerationStats } from '../../types/domain';
import { useStreamStore } from './stream.store';

const initial = useStreamStore.getState();
beforeEach(() => {
  useStreamStore.setState(initial, true);
});

const meta = { model: 'llama3.1:8b', promptId: null };
const stats: GenerationStats = {
  totalDurationMs: 1234,
  evalCount: 10,
  promptEvalCount: 5,
  tokensPerSecond: 8.1,
};

describe('useStreamStore state machine', () => {
  it('runs the happy path: idle → connecting → streaming → completed', () => {
    const s = useStreamStore.getState();
    s.start(meta);
    expect(useStreamStore.getState().status).toBe('connecting');
    expect(useStreamStore.getState().request).toEqual(meta);

    s.appendToken('Hel');
    expect(useStreamStore.getState().status).toBe('streaming');
    s.appendToken('lo');
    expect(useStreamStore.getState().text).toBe('Hello');

    s.complete(stats);
    expect(useStreamStore.getState().status).toBe('completed');
    expect(useStreamStore.getState().stats).toEqual(stats);
  });

  it('allows completing straight from connecting (empty non-streamed response)', () => {
    useStreamStore.getState().start(meta);
    useStreamStore.getState().complete(stats);
    expect(useStreamStore.getState().status).toBe('completed');
    expect(useStreamStore.getState().text).toBe('');
  });

  it('cancel is a normal terminal state that keeps the partial text', () => {
    const s = useStreamStore.getState();
    s.start(meta);
    s.appendToken('partial answer');
    s.cancel();
    expect(useStreamStore.getState().status).toBe('cancelled');
    expect(useStreamStore.getState().text).toBe('partial answer');
    expect(useStreamStore.getState().error).toBeNull();
  });

  it('fail keeps the partial text and records the typed error', () => {
    const failure = new OllamaError('offline', 'Ollama daemon is not reachable');
    const s = useStreamStore.getState();
    s.start(meta);
    s.appendToken('half a thought');
    s.fail(failure);
    expect(useStreamStore.getState().status).toBe('error');
    expect(useStreamStore.getState().text).toBe('half a thought');
    expect(useStreamStore.getState().error).toBe(failure);
  });

  it('start clears the previous run and is accepted from any terminal state', () => {
    const s = useStreamStore.getState();
    s.start(meta);
    s.appendToken('old');
    s.cancel();
    s.start({ model: 'phi4', promptId: 'p1' });
    const state = useStreamStore.getState();
    expect(state.status).toBe('connecting');
    expect(state.text).toBe('');
    expect(state.stats).toBeNull();
    expect(state.error).toBeNull();
    expect(state.request).toEqual({ model: 'phi4', promptId: 'p1' });
  });

  it('ignores tokens, completion, and cancel while idle', () => {
    const s = useStreamStore.getState();
    s.appendToken('ghost');
    s.complete(stats);
    s.cancel();
    const state = useStreamStore.getState();
    expect(state.status).toBe('idle');
    expect(state.text).toBe('');
    expect(state.stats).toBeNull();
  });

  it('ignores start while a request is active (no mid-flight restarts)', () => {
    const s = useStreamStore.getState();
    s.start(meta);
    s.appendToken('keep me');
    s.start({ model: 'other', promptId: null });
    const state = useStreamStore.getState();
    expect(state.status).toBe('streaming');
    expect(state.text).toBe('keep me');
    expect(state.request).toEqual(meta);
  });

  it('reset returns to a clean idle from any state', () => {
    const s = useStreamStore.getState();
    s.start(meta);
    s.appendToken('text');
    s.complete(stats);
    s.reset();
    expect(useStreamStore.getState()).toMatchObject({
      status: 'idle',
      text: '',
      stats: null,
      error: null,
      request: null,
    });
  });
});
