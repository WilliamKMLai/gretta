/**
 * Knowledge-base context provider (ARCHITECTURE.md §16; DECISIONS.md ADR-020).
 *
 * The RAG half of the pipeline: given the user's prompt as a retrieval query,
 * ask the companion for the top-k chunks from the collections BOUND TO THE OPEN
 * DOCUMENT, and return them as one labeled block plus the provenance the
 * response view cites.
 *
 * Everything here is best-effort by design. Disabled feature, no binding, a
 * companion that isn't running, an empty index — all return null, which the
 * runner drops silently so generation proceeds exactly as it would without RAG.
 */
import { getServices } from '../../../app/services';
import type { ContextBlock, ContextProvider, ContextRequest } from './provider';

/** Label shown above the injected block and in the sources list. */
export const KB_BLOCK_LABEL = 'Excerpts from your knowledge base';

export interface KnowledgeBaseProviderOptions {
  /** Master switch (settings.kbEnabled). */
  enabled: boolean;
  /** Collections bound to the active document. */
  collectionIds: string[];
  /** Chunks to retrieve; the companion's own default applies when omitted. */
  topK?: number | undefined;
}

/**
 * The line that precedes retrieved excerpts.
 *
 * Made explicit after a user observed that GRETTA would answer "how many
 * elements are in the periodic table" with the knowledge base off and decline
 * with it on. Nothing instructed it to; a block of numbered, sourced excerpts
 * simply reads to most instruction-tuned models as "answer from these". The
 * behaviour was emergent, which meant it was also unguaranteed — a different
 * model could drop it without warning, and a user who had come to rely on
 * their own documents overriding general knowledge would never be told.
 *
 * It is worth having deliberately: a knowledge base often holds unpublished
 * work that should take precedence over whatever the model absorbed in
 * training. So the preference is stated, and the escape hatch with it — a model
 * that cannot answer from the excerpts should say so rather than quietly
 * falling back, because silently mixing the two is the failure this prevents.
 */
export const EXCERPT_PREAMBLE =
  '--- excerpts from your knowledge base ---\n' +
  'Prefer these over your own general knowledge; they may contain unpublished ' +
  'or more recent work. If they do not answer the question, say so rather than ' +
  'answering from general knowledge without noting it.';

/**
 * Formats retrieved chunks for the prompt. Each excerpt is labeled with its
 * source and locator so the model can attribute claims, and the pane's Sources
 * list matches what the model saw.
 */
export function formatChunks(
  chunks: {
    source: string;
    locator: { page: number | null; paragraph: number | null };
    text: string;
  }[],
): string {
  if (chunks.length === 0) return '';
  const body = chunks
    .map((chunk, index) => {
      const where =
        chunk.locator.page !== null
          ? `p. ${String(chunk.locator.page)}`
          : chunk.locator.paragraph !== null
            ? `¶${String(chunk.locator.paragraph)}`
            : '';
      const cite = where === '' ? chunk.source : `${chunk.source}, ${where}`;
      return `[${String(index + 1)}] ${cite}\n${chunk.text.trim()}`;
    })
    .join('\n\n');
  return `${EXCERPT_PREAMBLE}\n\n${body}`;
}

export function createKnowledgeBaseProvider(
  options: KnowledgeBaseProviderOptions,
): ContextProvider {
  return {
    id: 'knowledge-base',
    async provide(request: ContextRequest): Promise<ContextBlock | null> {
      if (!options.enabled || options.collectionIds.length === 0) return null;
      const query = request.query.trim();
      if (query === '') return null;

      // A retrieval failure must never break generation (ADR-020): the
      // companion being absent is an ordinary state, not an error.
      let chunks;
      try {
        chunks = await getServices().kb.query(
          query,
          options.collectionIds,
          options.topK,
          request.signal,
        );
      } catch {
        return null;
      }
      if (chunks.length === 0) return null;

      return {
        providerId: 'knowledge-base',
        label: KB_BLOCK_LABEL,
        text: formatChunks(chunks),
        sources: chunks,
      };
    },
  };
}
