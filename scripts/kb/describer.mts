/**
 * Turning a rendered figure into searchable text (DECISIONS.md ADR-036).
 *
 * Mirrors the `Embedder` seam in embedder.mts deliberately — same shape, same
 * unreachable-error contract, same offline stand-in behind an env flag — so the
 * indexer treats "describe this picture" exactly as it treats "embed this
 * text": one interface, one failure mode, never a hard dependency.
 *
 * What this is *for* matters more than what it does. The description never
 * answers a user's question; the vision model does that directly, with the
 * actual pixels in hand. This exists so a figure can be **found** — so that
 * "which figure shows the dose response?" retrieves the right one even when the
 * caption says nothing more than "Figure 2: Results". Embedding finds the
 * figure; vision reads it.
 *
 * At a measured ~16s per figure on a 12B model, this is far too slow to run
 * over a whole corpus at index time, which is why it runs on demand and the
 * result is cached.
 */

/** Per-call ceiling so a wedged vision request releases its in-flight slot. */
export const OLLAMA_DESCRIBE_TIMEOUT_MS = 120_000;

/** Describes a rendered figure. One method so the indexer assumes no provider. */
export interface Describer {
  readonly model: string;
  /** Base64 PNG in, one paragraph of searchable prose out. */
  describe(imageBase64: string, caption: string, signal?: AbortSignal): Promise<string>;
}

/** Thrown when the vision backend is unreachable; never fatal to indexing. */
export class DescribeUnreachableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DescribeUnreachableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The instruction sent with every figure.
 *
 * Written for retrieval rather than for a reader: axis labels, units,
 * conditions, and the direction of the effect are the terms someone will
 * actually search for. Length is capped because this text is embedded — a
 * chunk that rambles dilutes its own vector.
 *
 * It states the fallback explicitly. A model asked to describe a page of prose
 * that contains no figure will otherwise invent one, and an invented
 * description is worse than none: it is indistinguishable from a real one and
 * it poisons retrieval permanently, since the result is cached.
 */
export const DESCRIBE_PROMPT =
  'Describe this figure so it can be found by search. State what is plotted, ' +
  'the axes and their units, the conditions or groups compared, and the ' +
  'direction of any trend or difference. Use the terminology a researcher ' +
  'would search for. Do not speculate beyond what is visible. If this is not a ' +
  'figure, reply exactly: NO FIGURE. Answer in at most four sentences.';

/** Reply that means "there was nothing here"; the caller stores no description. */
export const NO_FIGURE = 'NO FIGURE';

/** Beyond this the description is dilution, not detail. */
const MAX_DESCRIPTION_CHARS = 1200;

interface ChatResponse {
  message?: { content?: string };
  error?: string;
}

/** Real provider: POST /api/chat with an image, on the local Ollama daemon. */
export class OllamaDescriber implements Describer {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(model: string, baseUrl: string, timeoutMs = OLLAMA_DESCRIBE_TIMEOUT_MS) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async describe(imageBase64: string, caption: string, signal?: AbortSignal): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // Thinking would double the latency of an already-slow call for
          // output that is thrown away.
          think: false,
          messages: [
            {
              role: 'user',
              // The caption goes in as context: it names the entities the
              // figure is about, which a model reading axis labels alone
              // usually cannot recover.
              content: `${DESCRIBE_PROMPT}\n\nThe caption reads: ${caption}`,
              images: [imageBase64],
            },
          ],
        }),
        signal: requestSignal,
      });
    } catch (cause) {
      if (signal?.aborted === true) {
        throw cause instanceof Error ? cause : new Error('Aborted');
      }
      throw new DescribeUnreachableError(
        `Ollama is unreachable at ${this.baseUrl}. Is "ollama serve" running?`,
        cause,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // A model without vision answers "this model does not support image
      // input" with a 4xx. That is a configuration problem, not an outage, so
      // it must not masquerade as unreachability.
      throw new Error(
        `Ollama rejected the describe request (${String(response.status)}). ${body.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as ChatResponse;
    if (typeof payload.error === 'string') throw new Error(payload.error);
    return normalizeDescription(payload.message?.content ?? '');
  }
}

/** Trims, caps, and recognises the "nothing here" reply. */
export function normalizeDescription(raw: string): string {
  const text = raw.trim();
  if (text === '') return '';
  if (text.toUpperCase().startsWith(NO_FIGURE)) return '';
  return text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text;
}

/**
 * Offline stand-in (`GRETTA_KB_FAKE_DESCRIBE=1`).
 *
 * Deterministic and derived from the caption, so indexing tests exercise the
 * whole render → describe → re-embed path without a vision model installed —
 * the same bargain `DeterministicEmbedder` makes for embeddings.
 */
export class DeterministicDescriber implements Describer {
  readonly model = 'fake-describe';

  describe(_imageBase64: string, caption: string): Promise<string> {
    return Promise.resolve(`A figure showing ${caption.slice(0, 120)}`);
  }
}

/** Chooses the provider from configuration + environment (ADR-036 seam). */
export function createDescriber(model: string, ollamaUrl: string): Describer {
  if (process.env.GRETTA_KB_FAKE_DESCRIBE === '1') return new DeterministicDescriber();
  return new OllamaDescriber(model, ollamaUrl);
}
