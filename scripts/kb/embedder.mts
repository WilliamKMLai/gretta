/**
 * Embedding providers for the knowledge-base companion (DECISIONS.md ADR-020).
 *
 * The default provider is Ollama's `/api/embed` — the only network peer the
 * companion talks to besides serving the pane, keeping the system fully local
 * (ARCHITECTURE.md §13.5). `DeterministicEmbedder` is an explicit offline test
 * seam (enabled by `GRETTA_KB_FAKE_EMBED=1`) so the index pipeline and the
 * container rehearsal run without a live model; it is never used when a model
 * is configured and reachable.
 */

/** Turns text into vectors. One method so the store never assumes a provider. */
export interface Embedder {
  /** The model tag; stored in the index header to detect model changes. */
  readonly model: string;
  /** Embeds a batch; the result is parallel to `texts`. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Thrown when the embedding backend is unreachable (maps to `ollama-unreachable`). */
export class EmbedUnreachableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EmbedUnreachableError';
    if (cause !== undefined) this.cause = cause;
  }
}

interface EmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

/** Real provider: POST /api/embed on the local Ollama daemon. */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  private readonly baseUrl: string;

  constructor(model: string, baseUrl: string) {
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (cause) {
      throw new EmbedUnreachableError(
        `Ollama embeddings unreachable at ${this.baseUrl}. Is "ollama serve" running?`,
        cause,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Ollama /api/embed returned HTTP ${String(response.status)} ${detail}`.trim(),
      );
    }
    const body = (await response.json()) as EmbedResponse;
    const vectors = body.embeddings ?? (body.embedding?.length ? [body.embedding] : null);
    if (vectors?.length !== texts.length) {
      throw new Error('Ollama /api/embed returned an unexpected embeddings shape.');
    }
    return vectors;
  }
}

const FAKE_DIMS = 256;

/**
 * Deterministic hashing bag-of-words embedding — identical text yields an
 * identical vector and shared vocabulary yields real cosine overlap, which is
 * enough to exercise ranking offline. NOT a semantic model; test/dev only.
 */
export class DeterministicEmbedder implements Embedder {
  readonly model = 'deterministic-fake';

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => embedOne(text)));
  }
}

function embedOne(text: string): number[] {
  const vector = new Array<number>(FAKE_DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    const slot = hashToken(token) % FAKE_DIMS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector;
  const inv = 1 / Math.sqrt(norm);
  return vector.map((value) => value * inv);
}

/** Small deterministic FNV-1a hash; stable across runs and processes. */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Chooses the provider from configuration + environment (ADR-020 seam). */
export function createEmbedder(model: string, ollamaUrl: string): Embedder {
  if (process.env.GRETTA_KB_FAKE_EMBED === '1') return new DeterministicEmbedder();
  return new OllamaEmbedder(model, ollamaUrl);
}
