import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeterministicEmbedder, EmbedUnreachableError, OllamaEmbedder } from './embedder.mts';

describe('OllamaEmbedder and DeterministicEmbedder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] for an empty batch without calling fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const embedder = new OllamaEmbedder('nomic-embed-text:latest', 'http://127.0.0.1:11434');
    await expect(embedder.embed([])).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('attaches an AbortSignal to POST /api/embed and returns vectors', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      expect(init?.signal).toBeDefined();
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ embeddings: [[0.25, 0.75]] }),
      } as Response);
    });
    const embedder = new OllamaEmbedder('nomic-embed-text:latest', 'http://127.0.0.1:11434/');

    await expect(embedder.embed(['alpha'])).resolves.toEqual([[0.25, 0.75]]);
    expect(spy).toHaveBeenCalledWith('http://127.0.0.1:11434/api/embed', expect.anything());
  });

  it('maps a timed-out fetch to EmbedUnreachableError rather than hanging', async () => {
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
    const embedder = new OllamaEmbedder('nomic-embed-text:latest', 'http://127.0.0.1:11434', 20);

    await expect(embedder.embed(['alpha'])).rejects.toBeInstanceOf(EmbedUnreachableError);
  });

  it('propagates a caller-initiated abort without wrapping it as unreachable', async () => {
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
    const embedder = new OllamaEmbedder('nomic-embed-text:latest', 'http://127.0.0.1:11434');

    const pending = embedder.embed(['alpha'], controller.signal);
    await expect(pending).rejects.not.toBeInstanceOf(EmbedUnreachableError);
  });

  it('produces deterministic normalized vectors in offline mode', async () => {
    const fake = new DeterministicEmbedder();
    const [first, second] = await fake.embed(['Vantrellium buffer', 'Vantrellium buffer']);
    expect(first).toEqual(second);
  });
});
