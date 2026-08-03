/**
 * Local relevance re-ranking (DECISIONS.md ADR-029).
 *
 * The privacy trade this implements is worth restating, because the code looks
 * unremarkable and the reason it exists is not. ADR-028 permits only a broad,
 * reviewed keyword query on the wire. That query is a *recall* instrument: it
 * casts wide and returns records that may or may not bear on what the user
 * actually wrote. *Precision* then happens here, on the device — the selected
 * passage is embedded locally by the user's own Ollama, each candidate's title
 * and abstract likewise, and the ordering falls out of cosine similarity. The
 * specific claim therefore drives the ranking without ever being transmitted.
 * Being coarse on the network is precisely what buys the right to be precise
 * on the machine.
 *
 * `cosineSimilarity` duplicates `scripts/kb/score.mts` rather than importing
 * it: ADR-020 forbids value imports across the src/scripts realm boundary, and
 * twenty lines of arithmetic is the cheaper of the two costs. The duplication
 * is deliberate and tested on both sides — it is not drift.
 *
 * Pure: imports nothing but its own types, tested directly.
 */

/**
 * Cosine similarity of two equal-length vectors, clamped to [-1, 1]. Returns 0
 * for a zero vector (no direction) or a length mismatch — a dimension mismatch
 * means the embeddings came from different models and cannot be compared, and
 * scoring them as unrelated is safer than scoring them as anything else.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return raw > 1 ? 1 : raw < -1 ? -1 : raw;
}

/** A candidate awaiting ranking: an opaque payload plus its embedding. */
export interface Rankable<T> {
  payload: T;
  embedding: readonly number[];
}

/** A ranked candidate. `relevance` is the cosine score mapped to 0..1. */
export interface Ranked<T> {
  payload: T;
  relevance: number;
}

/**
 * Maps cosine's [-1, 1] onto the 0..1 the domain uses for `relevance`. Negative
 * similarity is not "less relevant than nothing" in any meaningful sense for
 * text embeddings, so it floors at 0 rather than being rescaled, which would
 * spread meaningless distinctions across the bottom half of the range.
 */
function toRelevance(similarity: number): number {
  return similarity < 0 ? 0 : similarity;
}

/**
 * Re-ranks candidates against the passage embedding, highest first.
 *
 * Ties preserve input order (`Array.prototype.sort` is stable per spec), so a
 * source's own ranking survives as the tie-breaker instead of being scrambled —
 * which matters because ADR-029 records that local re-ranking is *assumed* to
 * beat source ordering and has not yet been measured against it.
 *
 * Candidates whose embedding is empty or mis-dimensioned score 0 and sink,
 * rather than being dropped: a record the user can see and judge is better than
 * one that vanished because an embedding call came back short.
 */
export function rankByRelevance<T>(
  passageEmbedding: readonly number[],
  candidates: readonly Rankable<T>[],
): Ranked<T>[] {
  if (candidates.length === 0) return [];
  return candidates
    .map((candidate) => ({
      payload: candidate.payload,
      relevance: toRelevance(cosineSimilarity(passageEmbedding, candidate.embedding)),
    }))
    .sort((left, right) => right.relevance - left.relevance);
}

/**
 * The text embedded for a candidate. Title and abstract only — never full text,
 * which GRETTA does not have at search time, and never the venue name, which
 * would let a journal's title leak into a *relevance* score and quietly
 * reintroduce the prestige weighting ADR-029 keeps on a separate axis.
 */
export function embeddableText(record: { title: string; abstract: string | null }): string {
  const abstract = record.abstract?.trim() ?? '';
  const title = record.title.trim();
  return abstract === '' ? title : `${title}\n\n${abstract}`;
}

/**
 * Words carrying no topical signal. Deliberately short: a long stop list starts
 * discarding terms that matter in some field or other ("control", "state",
 * "significant"), and the scoring below already discounts anything common.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'these',
  'this',
  'to',
  'was',
  'were',
  'which',
  'with',
  'we',
  'our',
]);

/** Lowercases, splits on non-letters, drops stopwords and one-character tokens. */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length > 1 && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

/**
 * Lexical overlap between a passage and a candidate, 0..1.
 *
 * The fallback when no embedding model is available (ADR-030). It is worse than
 * embeddings in exactly the way that matters most here — it cannot see that
 * "hepatic" and "liver" are the same idea, which is precisely the gap between a
 * manuscript's phrasing and the literature's — so it is never the default. But
 * it is much better than presenting a source's own ordering as if it were
 * relevance, which is what the alternative amounted to.
 *
 * Scored against the *passage's* token count rather than the union: a long
 * abstract should not be penalised for covering ground beyond the claim, since
 * the question is how much of the claim the paper addresses, not how much of
 * the paper is about the claim.
 */
export function lexicalOverlap(passage: string, candidate: string): number {
  const passageTokens = tokenize(passage);
  if (passageTokens.size === 0) return 0;
  const candidateTokens = tokenize(candidate);
  if (candidateTokens.size === 0) return 0;

  let shared = 0;
  for (const token of passageTokens) {
    if (candidateTokens.has(token)) shared += 1;
  }
  return shared / passageTokens.size;
}

/**
 * Ranks by lexical overlap when embeddings are unavailable. Same contract as
 * `rankByRelevance`: stable ordering, nothing dropped, scores in 0..1 — so the
 * caller substitutes one for the other and the UI's only job is to say which
 * ran, since a user reading a ranked list deserves to know it was ranked by
 * word overlap rather than meaning.
 */
export function rankByOverlap<T>(
  passage: string,
  candidates: readonly { payload: T; text: string }[],
): Ranked<T>[] {
  if (candidates.length === 0) return [];
  return candidates
    .map((candidate) => ({
      payload: candidate.payload,
      relevance: lexicalOverlap(passage, candidate.text),
    }))
    .sort((left, right) => right.relevance - left.relevance);
}
