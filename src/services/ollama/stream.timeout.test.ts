/**
 * Idle-timeout behaviour (ADR-023).
 *
 * The regression these pin: the timeout used to be a wall clock on the whole
 * stream, so any generation slower than the window died with "the connection
 * was interrupted mid-generation" — reproducibly, on large or reasoning models
 * that legitimately run for minutes. It must measure silence instead.
 */
import { describe, expect, it } from 'vitest';
import { StreamError } from '../../types/errors';
import { createOllamaClient } from './client';
import type { ChatRequest, HttpTransport, StreamEvent } from './client.types';

const BASE = 'http://127.0.0.1:11434';
const enc = new TextEncoder();

const REQ: ChatRequest = {
  model: 'deepseek-r1:32b',
  messages: [{ role: 'user', content: 'Rewrite this abstract' }],
  options: { temperature: 0.7, top_p: 0.9, top_k: 40, num_ctx: 4096 },
  stream: true,
};

const line = (content: string): string =>
  `${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`;
const done = (): string =>
  `${JSON.stringify({
    message: { role: 'assistant', content: '' },
    done: true,
    total_duration: 1_000_000_000,
    eval_count: 5,
    prompt_eval_count: 2,
    eval_duration: 1_000_000_000,
  })}\n`;

/** Emits `count` chunks `gapMs` apart — a slow but perfectly healthy model. */
function trickle(count: number, gapMs: number): HttpTransport {
  return () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < count; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, gapMs));
              controller.enqueue(enc.encode(line(`tok${String(i)} `)));
            }
            controller.enqueue(enc.encode(done()));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
}

/** Opens, sends one chunk, then goes silent forever — a genuinely stalled model. */
const stalls: HttpTransport = () =>
  Promise.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(line('thinking')));
          // never closes, never sends again
        },
      }),
      { status: 200 },
    ),
  );

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('stream idle timeout', () => {
  it('survives a generation far longer than the timeout window, as long as data keeps arriving', async () => {
    // 6 chunks × 40 ms = 240 ms total, with a 100 ms idle window. Under the old
    // whole-stream wall clock this failed; with an idle clock it must pass.
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: trickle(6, 40),
      timeoutMs: 100,
    });
    const events = await drain(client.chat(REQ, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events.filter((event) => event.type === 'token')).toHaveLength(6);
  });

  it('still fails when the model genuinely goes silent', async () => {
    const client = createOllamaClient({ baseUrl: BASE, transport: stalls, timeoutMs: 80 });
    const error = await drain(client.chat(REQ, new AbortController().signal)).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(StreamError);
    expect((error as StreamError).message).toMatch(/stopped sending data/i);
  });

  it('keeps the partial text when it does time out', async () => {
    const client = createOllamaClient({ baseUrl: BASE, transport: stalls, timeoutMs: 80 });
    const error = await drain(client.chat(REQ, new AbortController().signal)).catch(
      (cause: unknown) => cause,
    );
    expect((error as StreamError).partialText).toBe('thinking');
  });

  it('a caller cancel is still a clean stop, not a timeout error', async () => {
    const controller = new AbortController();
    const client = createOllamaClient({
      baseUrl: BASE,
      transport: trickle(20, 20),
      timeoutMs: 5000,
    });
    const stream = client.chat(REQ, controller.signal);
    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (events.length === 2) controller.abort();
    }
    expect(events.length).toBeLessThan(20);
  });
});
