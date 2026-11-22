/**
 * OllamaClient fixture tests (ARCHITECTURE.md §14) — every network behavior
 * simulated through injected transports built on Response + ReadableStream.
 * No real Ollama here; the live stream + cancel run is the Phase 4 manual
 * exit gate.
 */
import { OllamaError, StreamError } from '../../types/errors';
import { createOllamaClient } from './client';
import type { ChatRequest, GenerateRequest, HttpTransport, StreamEvent } from './client.types';

const BASE = 'http://127.0.0.1:11434';
const enc = new TextEncoder();

const CHAT_REQ: ChatRequest = {
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hi' }],
  options: { temperature: 0.7, top_p: 0.9, top_k: 40, num_ctx: 2048 },
  stream: true,
};

const GEN_REQ: GenerateRequest = {
  model: 'llama3.2',
  prompt: 'Say hi',
  options: { temperature: 0.7, top_p: 0.9, top_k: 40, num_ctx: 2048 },
  stream: true,
};

const chatLine = (content: string): string =>
  `${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`;
const genLine = (response: string): string => `${JSON.stringify({ response, done: false })}\n`;
const doneLine = (): string =>
  `${JSON.stringify({
    message: { role: 'assistant', content: '' },
    done: true,
    total_duration: 2_000_000_000,
    eval_count: 40,
    prompt_eval_count: 10,
    eval_duration: 2_000_000_000,
  })}\n`;

function chunkedResponse(chunks: (string | Uint8Array)[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk);
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const respondWith =
  (response: Response): HttpTransport =>
  () =>
    Promise.resolve(response);

async function drain(
  iterable: AsyncIterable<StreamEvent>,
): Promise<{ events: StreamEvent[]; error: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of iterable) events.push(event);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

const signal = (): AbortSignal => new AbortController().signal;

describe('OllamaClient · streaming', () => {
  it('yields tokens then done with stats converted to ms and tok/s', async () => {
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(chunkedResponse([chatLine('Hel'), chatLine('lo'), doneLine()])),
    });
    const { events, error } = await drain(client.chat(CHAT_REQ, signal()));
    expect(error).toBeNull();
    expect(events).toEqual([
      { type: 'token', content: 'Hel' },
      { type: 'token', content: 'lo' },
      {
        type: 'done',
        stats: { totalDurationMs: 2000, evalCount: 40, promptEvalCount: 10, tokensPerSecond: 20 },
      },
    ]);
  });

  it('reassembles lines split mid-line and mid-multibyte across network chunks', async () => {
    const payload = enc.encode(genLine('He🦙') + genLine('llo') + doneLine());
    const splitInsideEmoji = payload.indexOf(0xf0) + 2;
    const splitInsideSecondLine = payload.length - 12;
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(
        chunkedResponse([
          payload.slice(0, splitInsideEmoji),
          payload.slice(splitInsideEmoji, splitInsideSecondLine),
          payload.slice(splitInsideSecondLine),
        ]),
      ),
    });
    const { events, error } = await drain(client.generate(GEN_REQ, signal()));
    expect(error).toBeNull();
    expect(events.slice(0, 2)).toEqual([
      { type: 'token', content: 'He🦙' },
      { type: 'token', content: 'llo' },
    ]);
    expect(events[2]?.type).toBe('done');
  });

  it('accepts a final line without a trailing newline', async () => {
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(chunkedResponse([chatLine('Hi'), doneLine().trimEnd()])),
    });
    const { events, error } = await drain(client.chat(CHAT_REQ, signal()));
    expect(error).toBeNull();
    expect(events.map((e) => e.type)).toEqual(['token', 'done']);
  });

  it('sends the request shape Ollama expects, omitting an unset seed', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: (url, init) => {
        captured = { url, init };
        return Promise.resolve(chunkedResponse([doneLine()]));
      },
    });
    await drain(client.chat(CHAT_REQ, signal()));
    expect(captured).not.toBeNull();
    const { url, init } = captured as unknown as { url: string; init: RequestInit };
    expect(url).toBe(`${BASE}/api/chat`);
    const body = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      messages: unknown[];
      options: Record<string, unknown>;
    };
    expect(body.model).toBe('llama3.2');
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.options.temperature).toBe(0.7);
    expect('seed' in body.options).toBe(false);
  });
});

describe('OllamaClient · cancellation and timeout', () => {
  it('caller abort ends the stream cleanly: no error, no done, reader cancelled', async () => {
    let cancelled = false;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    let sentFirst = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentFirst) {
          sentFirst = true;
          controller.enqueue(enc.encode(chatLine('Hel')));
          return;
        }
        // Held open until cancel() releases the gate; the stream is cancelled
        // by then, so closing it here would throw — just resolve.
        await gate;
      },
      cancel() {
        cancelled = true;
        releaseGate();
      },
    });
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(new Response(body, { status: 200 })),
    });
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    for await (const event of client.chat(CHAT_REQ, controller.signal)) {
      events.push(event);
      controller.abort();
    }
    expect(events).toEqual([{ type: 'token', content: 'Hel' }]);
    expect(cancelled).toBe(true);
  });

  it('maps a first-byte timeout to OllamaError("timeout")', async () => {
    vi.useFakeTimers();
    try {
      const client = createOllamaClient({
        baseUrl: BASE,
        timeoutMs: 5000,
        transport: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => {
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      });
      const iterator = client.generate(GEN_REQ, signal())[Symbol.asyncIterator]();
      // Attach the handler before the timer fires, or the rejection is
      // momentarily unobserved and vitest reports an unhandled error.
      const expectation = expect(iterator.next()).rejects.toMatchObject({
        name: 'OllamaError',
        kind: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(5001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OllamaClient · failure mapping', () => {
  it('maps a dropped connection to StreamError("interrupted") with the partial text', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(chatLine('Hel')));
      },
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(new Response(body, { status: 200 })),
    });
    const { events, error } = await drain(client.chat(CHAT_REQ, signal()));
    expect(events).toEqual([{ type: 'token', content: 'Hel' }]);
    expect(error).toBeInstanceOf(StreamError);
    expect(error).toMatchObject({ kind: 'interrupted', partialText: 'Hel' });
  });

  it('maps a mid-stream {"error"} line to StreamError("interrupted")', async () => {
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(
        chunkedResponse([chatLine('Hi'), '{"error":"model ran out of memory"}\n']),
      ),
    });
    const { events, error } = await drain(client.chat(CHAT_REQ, signal()));
    expect(events).toEqual([{ type: 'token', content: 'Hi' }]);
    expect(error).toMatchObject({ kind: 'interrupted', partialText: 'Hi' });
    expect((error as StreamError).message).toContain('out of memory');
  });

  it('maps a malformed line to StreamError("parse") keeping the partial text', async () => {
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(chunkedResponse([chatLine('Hi'), '{not json\n'])),
    });
    const { error } = await drain(client.chat(CHAT_REQ, signal()));
    expect(error).toMatchObject({ name: 'StreamError', kind: 'parse', partialText: 'Hi' });
  });

  it('maps a stream that closes without done to StreamError("interrupted")', async () => {
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(chunkedResponse([chatLine('Hi')])),
    });
    const { error } = await drain(client.chat(CHAT_REQ, signal()));
    expect(error).toMatchObject({ kind: 'interrupted', partialText: 'Hi' });
  });

  it('maps HTTP 404 with a not-found body to OllamaError("model-not-found")', async () => {
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(new Response('{"error":"model \\"x\\" not found"}', { status: 404 })),
    });
    const { error } = await drain(client.chat(CHAT_REQ, signal()));
    expect(error).toMatchObject({ name: 'OllamaError', kind: 'model-not-found', code: '404' });
    expect((error as OllamaError).message).toContain('llama3.2');
  });

  it('maps other HTTP failures to OllamaError("http") with the server message', async () => {
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(new Response('{"error":"boom"}', { status: 500 })),
    });
    const { error } = await drain(client.chat(CHAT_REQ, signal()));
    expect(error).toMatchObject({ kind: 'http', code: '500' });
    expect((error as OllamaError).message).toContain('boom');
  });

  it('classifies fetch TypeErrors: offline vs cors-or-mixed-content', async () => {
    const offline = createOllamaClient({
      baseUrl: BASE,
      transport: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(offline.listModels()).rejects.toMatchObject({ kind: 'offline' });

    const blocked = createOllamaClient({
      baseUrl: BASE,
      transport: (_url, init) =>
        init.mode === 'no-cors'
          ? Promise.resolve(new Response(null, { status: 200 }))
          : Promise.reject(new TypeError('blocked')),
    });
    await expect(blocked.listModels()).rejects.toMatchObject({ kind: 'cors-or-mixed-content' });
  });

  it('ends cleanly when cancelled while the no-cors failure probe is in flight', async () => {
    const controller = new AbortController();
    const transport: HttpTransport = (_url, init) => {
      if (init.mode === 'no-cors') {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
          controller.abort();
        });
      }
      return Promise.reject(new TypeError('fetch failed'));
    };
    const client = createOllamaClient({ baseUrl: BASE, transport });

    const { events, error } = await drain(client.chat(CHAT_REQ, controller.signal));
    expect(events).toEqual([]);
    expect(error).toBeNull();
  });
});

describe('OllamaClient · non-streaming and unary endpoints', () => {
  it('stream:false yields one full token then done', async () => {
    const body = JSON.stringify({
      message: { role: 'assistant', content: 'Full answer' },
      done: true,
      total_duration: 1_000_000_000,
      eval_count: 20,
      prompt_eval_count: 5,
      eval_duration: 1_000_000_000,
    });
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(new Response(body, { status: 200 })),
    });
    const { events, error } = await drain(client.chat({ ...CHAT_REQ, stream: false }, signal()));
    expect(error).toBeNull();
    expect(events).toEqual([
      { type: 'token', content: 'Full answer' },
      {
        type: 'done',
        stats: { totalDurationMs: 1000, evalCount: 20, promptEvalCount: 5, tokensPerSecond: 20 },
      },
    ]);
  });

  it('health() parses /api/version and honors baseUrlOverride', async () => {
    const urls: string[] = [];
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: (url) => {
        urls.push(url);
        return Promise.resolve(new Response('{"version":"0.9.9"}', { status: 200 }));
      },
    });
    await expect(client.health()).resolves.toEqual({ version: '0.9.9' });
    await expect(client.health(undefined, 'https://localhost:11435')).resolves.toEqual({
      version: '0.9.9',
    });
    expect(urls).toEqual([`${BASE}/api/version`, 'https://localhost:11435/api/version']);
  });

  it('listModels() normalizes /api/tags including missing detail fields', async () => {
    const tags = JSON.stringify({
      models: [
        {
          name: 'llama3.2:latest',
          size: 2_000_000_000,
          modified_at: '2026-07-01T00:00:00Z',
          details: { parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
        },
        { name: 'tiny', size: 1, modified_at: '2026-07-02T00:00:00Z' },
      ],
    });
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(new Response(tags, { status: 200 })),
    });
    await expect(client.listModels()).resolves.toEqual([
      {
        name: 'llama3.2:latest',
        size: 2_000_000_000,
        modifiedAt: '2026-07-01T00:00:00Z',
        parameterSize: '3.2B',
        quantization: 'Q4_K_M',
      },
      {
        name: 'tiny',
        size: 1,
        modifiedAt: '2026-07-02T00:00:00Z',
        parameterSize: null,
        quantization: null,
      },
    ]);
  });

  it('listModels() maps a wrong-shaped body to OllamaError("invalid-response")', async () => {
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: respondWith(new Response('{"nope":1}', { status: 200 })),
    });
    await expect(client.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('showModel() sends both model and name keys and extracts the context length', async () => {
    let bodyText = '';
    const show = JSON.stringify({
      details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
      model_info: { 'llama.context_length': 131072, 'llama.embedding_length': 3072 },
      capabilities: ['completion', 'tools'],
    });
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: (_url, init) => {
        bodyText = init.body as string;
        return Promise.resolve(new Response(show, { status: 200 }));
      },
    });
    await expect(client.showModel('llama3.2')).resolves.toEqual({
      family: 'llama',
      parameterSize: '3.2B',
      quantizationLevel: 'Q4_K_M',
      format: null,
      contextLength: 131072,
      capabilities: ['completion', 'tools'],
    });
    const sent = JSON.parse(bodyText) as { model: string; name: string };
    expect(sent).toEqual({ model: 'llama3.2', name: 'llama3.2' });
  });

  it('reports a locally imported build as safetensors with no vision capability', async () => {
    // The real shape behind "but this model family has vision": a converted
    // build reports no vision tower, and Ollama then refuses the image itself
    // with "this model does not support image input" (ADR-034). `format` is
    // what lets the pane explain that rather than just deny it.
    const show = JSON.stringify({
      details: { family: 'gemma4_unified', parameter_size: '12.4B', format: 'safetensors' },
      capabilities: ['completion', 'tools', 'thinking'],
    });
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: () => Promise.resolve(new Response(show, { status: 200 })),
    });
    await expect(client.showModel('gemma4:12b-mlx')).resolves.toEqual({
      family: 'gemma4_unified',
      parameterSize: '12.4B',
      quantizationLevel: null,
      format: 'safetensors',
      contextLength: null,
      capabilities: ['completion', 'tools', 'thinking'],
    });
  });
});

describe('embed', () => {
  const vectors = (n: number): number[][] => Array.from({ length: n }, (_, i) => [i, i + 1, i + 2]);

  it('returns one vector per input', async () => {
    const transport = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ embeddings: vectors(2) }))),
    );
    const client = createOllamaClient({ baseUrl: BASE, transport });

    expect(await client.embed('nomic-embed-text', ['a', 'b'])).toHaveLength(2);
  });

  it('issues no request for an empty input list', async () => {
    const transport = vi.fn();
    const client = createOllamaClient({ baseUrl: BASE, transport });

    expect(await client.embed('nomic-embed-text', [])).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('splits a large set across requests and preserves order', async () => {
    // Order is the only thing tying a vector to the text it came from.
    let call = 0;
    const transport = vi.fn(() => {
      call += 1;
      const size = call === 1 ? 32 : 4;
      const offset = call === 1 ? 0 : 32;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            embeddings: Array.from({ length: size }, (_, i) => [offset + i]),
          }),
        ),
      );
    });
    const client = createOllamaClient({ baseUrl: BASE, transport });

    const result = await client.embed(
      'nomic-embed-text',
      Array.from({ length: 36 }, (_, i) => `text ${String(i)}`),
    );

    expect(transport).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(36);
    expect(result[0]).toEqual([0]);
    expect(result[35]).toEqual([35]);
  });

  it('rejects a response with the wrong number of vectors', async () => {
    const transport = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ embeddings: vectors(1) }))),
    );
    const client = createOllamaClient({ baseUrl: BASE, transport });

    await expect(client.embed('nomic-embed-text', ['a', 'b'])).rejects.toBeInstanceOf(OllamaError);
  });

  it('allows far longer than a metadata call before timing out', async () => {
    // Sharing the 10s metadata budget meant every cold model load timed out and
    // literature ranking silently fell back to word overlap.
    vi.useFakeTimers();
    try {
      const transport = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(new Response(JSON.stringify({ embeddings: vectors(1) })));
            }, 30_000);
          }),
      );
      const client = createOllamaClient({ baseUrl: BASE, transport });
      const pending = client.embed('nomic-embed-text', ['a']);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await pending).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
