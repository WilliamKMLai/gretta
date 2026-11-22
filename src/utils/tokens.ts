/**
 * Prompt-size estimation (DECISIONS.md ADR-025).
 *
 * Ollama exposes no tokenizer endpoint — the long-standing feature request is
 * still open — so the only exact count available is `prompt_eval_count`, which
 * arrives in the `done` event *after* a generation. Everything before that is
 * an estimate.
 *
 * The estimate is therefore characters ÷ a per-model ratio, deliberately
 * conservative so it over-states rather than under-states: an over-estimate
 * costs a little retrieval headroom, whereas an under-estimate silently
 * truncates the prompt, which is the failure this whole module exists to
 * prevent (ADR-022).
 *
 * The ratio is not guesswork for long: `observeRatio` compares each prediction
 * against the count Ollama actually reported, so the estimate converges on the
 * truth for the models a user actually runs.
 */

/**
 * Starting ratio, in characters per token. English prose runs ~4.0; 3.6 is
 * intentionally pessimistic, and technical text with symbols and long
 * identifiers genuinely tokenises denser than prose.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.6;

/** Ratios outside this range indicate a bad sample, not a real measurement. */
const PLAUSIBLE_RATIO = { min: 1.5, max: 8 } as const;

/** Below this many prompt tokens, chat-template overhead dominates the sample. */
const MIN_SAMPLE_TOKENS = 24;

/** Estimated tokens for a piece of text. Always ≥ 1 for non-empty input. */
export function estimateTokens(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  if (text === '') return 0;
  const ratio = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.max(1, Math.ceil(text.length / ratio));
}

/** How many characters fit in a token budget at the given ratio. */
export function charsForTokens(tokens: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  if (tokens <= 0) return 0;
  const ratio = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.floor(tokens * ratio);
}

/**
 * Folds one observation into the running ratio for a model.
 *
 * Returns the previous ratio unchanged when the sample is not trustworthy:
 * a tiny prompt (template overhead dominates), a missing or zero count, or an
 * implausible result. Ollama reuses cached prompt prefixes, which can report a
 * `prompt_eval_count` far below the real prompt size — exactly the kind of
 * sample that would otherwise poison the estimate.
 *
 * Smoothing is an exponential moving average so a single odd generation cannot
 * move the ratio far.
 */
export function observeRatio(
  previous: number,
  promptChars: number,
  promptEvalCount: number,
  weight = 0.3,
): number {
  if (promptEvalCount < MIN_SAMPLE_TOKENS || promptChars <= 0) return previous;
  const observed = promptChars / promptEvalCount;
  if (observed < PLAUSIBLE_RATIO.min || observed > PLAUSIBLE_RATIO.max) return previous;
  const blended = previous * (1 - weight) + observed * weight;
  return Math.min(PLAUSIBLE_RATIO.max, Math.max(PLAUSIBLE_RATIO.min, blended));
}

function omissionMarker(omitted: number): string {
  return `\n\n[… ${omitted.toLocaleString()} characters omitted to fit the context window …]\n\n`;
}

/**
 * Shortens text to a character budget, keeping the beginning and the end and
 * eliding the middle. Documents carry their framing at the top and their
 * conclusions at the bottom, so middle-out loses less than a head or tail cut —
 * and the marker means the model is told material is missing rather than being
 * left to infer a non-sequitur.
 */
export function trimMiddle(text: string, maxChars: number): string {
  const budget = Math.floor(maxChars);
  if (budget <= 0) return '';
  if (text.length <= budget) return text;

  let keep = Math.max(0, budget - omissionMarker(text.length - budget).length);
  let marker = omissionMarker(text.length - keep);
  keep = Math.max(0, budget - marker.length);
  marker = omissionMarker(text.length - keep);

  if (budget - marker.length <= 0) {
    const compact = marker.trim();
    if (compact.length <= budget) return compact;
    return budget === 1 ? '…' : `${text.slice(0, budget - 1).trimEnd()}…`;
  }

  keep = budget - marker.length;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  const suffix = tail > 0 ? text.slice(text.length - tail).trimStart() : '';
  return `${text.slice(0, head).trimEnd()}${marker}${suffix}`;
}
