/**
 * useGeneration against scripted fake transports (ARCHITECTURE.md §13:
 * "ReadableStream fixtures: happy path, cancel mid-stream, malformed line,
 * connection drop"). The Ollama client is faked at the OllamaClient seam —
 * the async-generator contract — which is what the real NDJSON stream layer
 * produces; the stream layer itself has its own fixture tests.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { setServices } from '../../app/services';
import type { ClipboardService } from '../../services/clipboard';
import type { OfficeService, SelectionInfo } from '../../services/office';
import type { ChatRequest, OllamaClient, StreamEvent } from '../../services/ollama';
import type { GenerationStats, PromptTemplate } from '../../types/domain';
import { StreamError } from '../../types/errors';
import { useHistoryStore } from '../history';
import { useSettingsStore } from '../settings';
import { useStreamStore } from './stream.store';
import type { ToastAction } from '../../components/toaster';
import type { GenerationInput } from './request';
import { abortActiveGeneration, useGeneration } from './useGeneration';

const toastSpies = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../components/toaster', () => ({
  APP_TOASTER_ID: 'test-toaster',
  useAppToasts: () => toastSpies,
}));

// ---------- fakes ----------

const token = (content: string): StreamEvent => ({ type: 'token', content });
const doneStats: GenerationStats = {
  totalDurationMs: 1200,
  evalCount: 42,
  promptEvalCount: 7,
  tokensPerSecond: 35,
};
const done = (): StreamEvent => ({ type: 'done', stats: doneStats });

type ChatScript = (
  request: ChatRequest,
  signal: AbortSignal,
) => AsyncGenerator<StreamEvent, void, undefined>;

function makeClient(script: ChatScript): { client: OllamaClient; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const client = {
    chat: (request: ChatRequest, signal: AbortSignal) => {
      calls.push(request);
      return script(request, signal);
    },
  } as unknown as OllamaClient;
  return { client, calls };
}

function scripted(events: StreamEvent[]): ChatScript {
  return async function* run(_request, signal) {
    for (const event of events) {
      if (signal.aborted) return;
      yield event;
      await Promise.resolve();
    }
  };
}

/** Yields `events`, pausing before index `gateBefore` until release(). */
function gatedScript(
  events: StreamEvent[],
  gateBefore: number,
): { script: ChatScript; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const script: ChatScript = async function* run(_request, signal) {
    for (const [index, event] of events.entries()) {
      if (index === gateBefore) await gate;
      if (signal.aborted) return;
      yield event;
      await Promise.resolve();
    }
  };
  return { script, release };
}

/** Yields the events, then waits for abort and ends silently (ADR-011). */
function abortableScript(events: StreamEvent[]): ChatScript {
  return async function* run(_request, signal) {
    for (const event of events) {
      yield event;
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
  };
}

const selection = (text: string): SelectionInfo => ({ text, isEmpty: text.trim() === '' });

interface OfficeFake {
  office: OfficeService;
  insertAtCursor: ReturnType<typeof vi.fn>;
}

function makeOffice(overrides: Partial<OfficeService> = {}): OfficeFake {
  const insertAtCursor = vi.fn(() => Promise.resolve());
  const office = {
    getSelection: vi.fn(() => Promise.resolve(selection('SELECTED TEXT'))),
    getParagraph: vi.fn(() => Promise.resolve('PARAGRAPH TEXT')),
    getDocument: vi.fn(() => Promise.resolve('DOCUMENT TEXT')),
    insertAtCursor,
    ...overrides,
  } as unknown as OfficeService;
  return { office, insertAtCursor };
}

function makeClipboard(): { clipboard: ClipboardService; copy: ReturnType<typeof vi.fn> } {
  const copy = vi.fn(() => Promise.resolve());
  return { clipboard: { copy }, copy };
}

// ---------- fixtures ----------

const template: PromptTemplate = {
  id: 'tpl-clarity',
  name: 'Improve clarity',
  category: 'editing',
  description: 'Tighten the selected text.',
  system: 'You are a precise editor.',
  user: 'Improve: {{selection}}',
  requires: ['selection'],
  builtIn: true,
  defaults: { temperature: 0.2 },
};

const baseInput = (over: Partial<GenerationInput> = {}): GenerationInput => ({
  template,
  draft: 'make it pop',
  contextSource: 'selection',
  model: 'llama3',
  ...over,
});

// ---------- rAF control ----------

let rafQueue: FrameRequestCallback[] = [];
const flushFrames = (): void => {
  const queue = rafQueue;
  rafQueue = [];
  for (const callback of queue) callback(0);
};

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    rafQueue.push(callback);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (): void => {
    rafQueue = [];
  });
  abortActiveGeneration();
  useStreamStore.getState().reset();
  useHistoryStore.setState({ records: [], activeRecordId: null });
  useSettingsStore.getState().resetSettings();
  toastSpies.success.mockClear();
  toastSpies.error.mockClear();
  toastSpies.info.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- tests ----------

describe('useGeneration — happy path', () => {
  it('streams to completion: request shape, machine, history record, options merge', async () => {
    const { client, calls } = makeClient(scripted([token('Hel'), token('lo'), done()]));
    const { office } = makeOffice();
    const { clipboard, copy } = makeClipboard();
    setServices({ ollama: client, office, clipboard });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput());
    });

    const stream = useStreamStore.getState();
    expect(stream.status).toBe('completed');
    expect(stream.text).toBe('Hello');
    expect(stream.stats?.evalCount).toBe(42);

    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request?.model).toBe('llama3');
    expect(request?.stream).toBe(true);
    expect(request?.messages).toEqual([
      { role: 'system', content: 'You are a precise editor.' },
      { role: 'user', content: 'Improve: SELECTED TEXT' },
    ]);
    // settings ⊕ template defaults, mapped to wire names; seed omitted when null
    expect(request?.options).toEqual({ temperature: 0.2, top_p: 0.9, top_k: 40, num_ctx: 4096 });

    const { records } = useHistoryStore.getState();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      prompt: 'make it pop',
      response: 'Hello',
      outcome: 'completed',
      model: 'llama3',
      stats: doneStats,
    });

    expect(copy).not.toHaveBeenCalled();
  });

  it('batches many tokens into one rAF append', async () => {
    const { script, release } = gatedScript([token('a'), token('b'), token('c'), done()], 3);
    const { client } = makeClient(script);
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });

    const textTransitions: string[] = [];
    const unsubscribe = useStreamStore.subscribe((state, previous) => {
      if (state.text !== previous.text) textTransitions.push(state.text);
    });

    const { result } = renderHook(() => useGeneration());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.generate(baseInput());
      await waitFor(() => {
        expect(rafQueue).toHaveLength(1); // three tokens queued, one frame scheduled
      });
    });
    expect(useStreamStore.getState().text).toBe('');

    act(() => {
      flushFrames();
    });
    expect(textTransitions).toEqual(['abc']); // one append for the whole frame

    release();
    await act(async () => {
      await pending;
    });
    expect(useStreamStore.getState().status).toBe('completed');
    expect(useStreamStore.getState().text).toBe('abc');
    unsubscribe();
  });
});

describe('useGeneration — cancellation and failure', () => {
  it('stop() keeps the partial text, lands in cancelled, and still finalizes', async () => {
    const { client } = makeClient(abortableScript([token('partial ')]));
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });
    useSettingsStore.getState().setSettings({ autoCopy: true }); // must NOT fire on cancel

    const { result } = renderHook(() => useGeneration());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.generate(baseInput());
      await waitFor(() => {
        expect(rafQueue).toHaveLength(1);
      });
    });
    act(() => {
      flushFrames();
    });
    expect(useStreamStore.getState().status).toBe('streaming');

    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await pending;
    });

    const stream = useStreamStore.getState();
    expect(stream.status).toBe('cancelled');
    expect(stream.text).toBe('partial ');

    const { records } = useHistoryStore.getState();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ response: 'partial ', outcome: 'cancelled' });
    expect(records[0]?.stats).toBeUndefined();
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  it('a mid-stream throw lands in error with the partial text kept', async () => {
    const failing: ChatScript = async function* run() {
      yield token('half');
      await Promise.resolve();
      throw new StreamError('parse', 'Malformed NDJSON line.', 'half');
    };
    const { client } = makeClient(failing);
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput());
    });

    const stream = useStreamStore.getState();
    expect(stream.status).toBe('error');
    expect(stream.text).toBe('half');
    expect(stream.error).toBeInstanceOf(StreamError);
    expect((stream.error as StreamError).kind).toBe('parse');

    expect(useHistoryStore.getState().records[0]).toMatchObject({
      response: 'half',
      outcome: 'error',
    });
  });

  it('a stream that ends without done (and without abort) is an interruption', async () => {
    const { client } = makeClient(scripted([token('x')])); // no done event
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput());
    });

    const stream = useStreamStore.getState();
    expect(stream.status).toBe('error');
    expect((stream.error as StreamError).kind).toBe('interrupted');
    expect(stream.error?.message).toContain('closed before the response finished');
    expect(stream.text).toBe('x');
  });

  it('stop() while idle is harmless', () => {
    setServices({
      ollama: makeClient(scripted([done()])).client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });
    const { result } = renderHook(() => useGeneration());
    act(() => {
      result.current.stop();
    });
    expect(useStreamStore.getState().status).toBe('idle');
  });
});

describe('useGeneration — requirements (§11.1: checked before the machine starts)', () => {
  it('an empty selection stops with a typed toast and never touches the stream', async () => {
    const { client, calls } = makeClient(scripted([done()]));
    const { office } = makeOffice({
      getSelection: vi.fn(() => Promise.resolve(selection('   '))),
    });
    setServices({ ollama: client, office, clipboard: makeClipboard().clipboard });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput());
    });

    expect(toastSpies.error).toHaveBeenCalledWith(expect.stringContaining('Select some text'));
    expect(useStreamStore.getState().status).toBe('idle');
    expect(calls).toHaveLength(0);
    expect(useHistoryStore.getState().records).toHaveLength(0);
  });

  it('an office read failure is wrapped and toasted, machine untouched', async () => {
    const { client, calls } = makeClient(scripted([done()]));
    const { office } = makeOffice({
      getDocument: vi.fn(() => Promise.reject(new Error('Word.run exploded'))),
    });
    setServices({ ollama: client, office, clipboard: makeClipboard().clipboard });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(
        baseInput({ template: null, draft: 'Summarize', contextSource: 'document' }),
      );
    });

    expect(toastSpies.error).toHaveBeenCalledWith('Could not read the document.');
    expect(useStreamStore.getState().status).toBe('idle');
    expect(calls).toHaveLength(0);
  });

  it('an empty draft on a free prompt stops with an info toast', async () => {
    const { client, calls } = makeClient(scripted([done()]));
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput({ template: null, draft: '   ' }));
    });

    expect(toastSpies.info).toHaveBeenCalledWith('Write a prompt first.');
    expect(calls).toHaveLength(0);
  });
});

describe('useGeneration — free prompts, settings, and post-actions', () => {
  it('composes the free prompt with its labeled context block and honors seed', async () => {
    const { client, calls } = makeClient(scripted([token('ok'), done()]));
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });
    useSettingsStore.getState().setSettings({ seed: 7, temperature: 0.5 });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(
        baseInput({ template: null, draft: 'Summarize this', contextSource: 'selection' }),
      );
    });

    const request = calls[0];
    expect(request?.messages).toEqual([
      {
        role: 'user',
        content: 'Summarize this\n\n--- selection ---\n\nSELECTED TEXT',
      },
    ]);
    expect(request?.options).toEqual({
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40,
      num_ctx: 4096,
      seed: 7,
    });
  });

  it('runs autoCopy and autoInsert with the final text on completion only', async () => {
    const { client } = makeClient(scripted([token('Result!'), done()]));
    const { office, insertAtCursor } = makeOffice();
    const { clipboard, copy } = makeClipboard();
    setServices({ ollama: client, office, clipboard });
    useSettingsStore.getState().setSettings({ autoCopy: true, autoInsert: true });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput());
    });

    expect(copy).toHaveBeenCalledWith('Result!');
    expect(insertAtCursor).toHaveBeenCalledWith('Result!');
  });

  it('a blocked auto-copy raises a gesture-carrying action toast that retries', async () => {
    const { client } = makeClient(scripted([token('Result!'), done()]));
    const { office } = makeOffice();
    const { clipboard, copy } = makeClipboard();
    copy.mockRejectedValueOnce(new Error('NotAllowedError'));
    setServices({ ollama: client, office, clipboard });
    useSettingsStore.getState().setSettings({ autoCopy: true });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput());
    });

    expect(copy).toHaveBeenCalledTimes(1);
    expect(toastSpies.error).toHaveBeenCalledWith(
      expect.stringContaining('Auto-copy was blocked'),
      expect.objectContaining({ label: 'Copy result' }),
    );
    const actionCall = toastSpies.error.mock.calls.find((args) => args[1] !== undefined);
    const action = actionCall?.[1] as ToastAction;
    act(() => {
      action.onClick();
    });
    await waitFor(() => {
      expect(copy).toHaveBeenCalledTimes(2);
    });
    expect(copy).toHaveBeenLastCalledWith('Result!');
  });

  it('retry() re-issues the last input and records a second run', async () => {
    const { client, calls } = makeClient(scripted([token('Hello'), done()]));
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput());
    });
    expect(calls).toHaveLength(1);

    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(calls).toHaveLength(2);
      expect(useStreamStore.getState().status).toBe('completed');
    });

    expect(calls[1]).toEqual(calls[0]);
    // Two runs → two independent records; nothing is "continued" (ADR-021).
    expect(useHistoryStore.getState().records).toHaveLength(2);
  });

  it('stop() from a remounted hook cancels an active stream after view switch', async () => {
    const { client } = makeClient(abortableScript([token('partial ')]));
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });

    const first = renderHook(() => useGeneration());
    let pending!: Promise<void>;
    await act(async () => {
      pending = first.result.current.generate(baseInput());
      await waitFor(() => {
        expect(rafQueue).toHaveLength(1);
      });
    });
    act(() => {
      flushFrames();
    });
    first.unmount();

    const second = renderHook(() => useGeneration());
    act(() => {
      second.result.current.stop();
    });
    await act(async () => {
      await pending;
    });

    expect(useStreamStore.getState().status).toBe('cancelled');
    expect(useStreamStore.getState().text).toBe('partial ');
    expect(useHistoryStore.getState().records[0]).toMatchObject({
      response: 'partial ',
      outcome: 'cancelled',
    });
  });

  it('abortActiveGeneration + reset discards an in-flight run without side effects', async () => {
    const { client } = makeClient(abortableScript([token('partial ')]));
    const { office, insertAtCursor } = makeOffice();
    const { clipboard, copy } = makeClipboard();
    setServices({ ollama: client, office, clipboard });
    useSettingsStore.getState().setSettings({ autoCopy: true, autoInsert: true });

    const { result } = renderHook(() => useGeneration());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.generate(baseInput());
      await waitFor(() => {
        expect(rafQueue).toHaveLength(1);
      });
    });

    act(() => {
      abortActiveGeneration();
      useStreamStore.getState().reset();
    });
    await act(async () => {
      await pending;
    });

    expect(useStreamStore.getState().status).toBe('idle');
    expect(useStreamStore.getState().text).toBe('');
    expect(useHistoryStore.getState().records).toHaveLength(0);
    expect(copy).not.toHaveBeenCalled();
    expect(insertAtCursor).not.toHaveBeenCalled();
  });

  it('counts priorResult in budget so oversized Refine runs report overflow', async () => {
    const { client, calls } = makeClient(scripted([token('ok'), done()]));
    setServices({
      ollama: client,
      office: makeOffice().office,
      clipboard: makeClipboard().clipboard,
    });
    useSettingsStore.getState().setSettings({ contextLength: 1024 });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(
        baseInput({
          template: null,
          draft: 'Make it shorter',
          contextSource: 'none',
          priorResult: 'p'.repeat(20_000),
        }),
      );
    });

    expect(calls).toHaveLength(0);
    expect(toastSpies.error).toHaveBeenCalledWith(expect.stringContaining('only'));
    expect(useStreamStore.getState().status).toBe('idle');
  });

  it('autoInsert strips Markdown and marks the record applied only on success', async () => {
    const { client } = makeClient(scripted([token('## Heading\n\n**Bold** text'), done()]));
    const { office, insertAtCursor } = makeOffice();
    insertAtCursor.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Word busy'));
    setServices({ ollama: client, office, clipboard: makeClipboard().clipboard });
    useSettingsStore.getState().setSettings({ autoInsert: true });

    const { result } = renderHook(() => useGeneration());
    await act(async () => {
      await result.current.generate(baseInput());
    });

    expect(insertAtCursor).toHaveBeenCalledWith('Heading\n\nBold text');
    expect(useHistoryStore.getState().records[0]?.applied?.kind).toBe('insert');

    await act(async () => {
      await result.current.generate(baseInput());
    });
    expect(useHistoryStore.getState().records[0]?.applied).toBeUndefined();
  });
});
