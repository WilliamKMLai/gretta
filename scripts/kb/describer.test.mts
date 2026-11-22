import { afterEach, describe, expect, it, vi } from 'vitest';
import { DescribeUnreachableError, OllamaDescriber, normalizeDescription } from './describer.mts';

describe('OllamaDescriber and normalizeDescription', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('trims prose, caps overlong output, and drops NO FIGURE replies', () => {
    expect(normalizeDescription('  NO FIGURE.  ')).toBe('');
    expect(normalizeDescription('   ')).toBe('');
    expect(normalizeDescription('  Dose response curve.  ')).toBe('Dose response curve.');
    expect(normalizeDescription('x'.repeat(1500))).toHaveLength(1200);
  });

  it('sends an AbortSignal and returns the normalized vision description', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      expect(init?.signal).toBeDefined();
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ message: { content: '  Axes show time vs pH.  ' } }),
      } as Response);
    });
    const describer = new OllamaDescriber('qwen2.5vl:7b', 'http://127.0.0.1:11434');

    await expect(describer.describe('b64', 'Figure 1.')).resolves.toBe('Axes show time vs pH.');
  });

  it('maps a timed-out vision request to DescribeUnreachableError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Timed out', 'TimeoutError'));
          },
          { once: true },
        );
      });
    });
    const describer = new OllamaDescriber('qwen2.5vl:7b', 'http://127.0.0.1:11434', 20);

    await expect(describer.describe('b64', 'Figure 1.')).rejects.toBeInstanceOf(
      DescribeUnreachableError,
    );
  });

  it('propagates a caller-initiated abort rather than reporting Ollama unreachable', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
        controller.abort();
      });
    });
    const describer = new OllamaDescriber('qwen2.5vl:7b', 'http://127.0.0.1:11434');

    const pending = describer.describe('b64', 'Figure 1.', controller.signal);
    await expect(pending).rejects.not.toBeInstanceOf(DescribeUnreachableError);
  });
});
