/**
 * Fetching the figures a retrieval actually surfaced (DECISIONS.md ADR-036).
 *
 * Runs AFTER `allocateBudget`, deliberately. Budgeting can drop the weakest
 * excerpts, and fetching a figure for a chunk that then gets trimmed would
 * spend a round trip on a picture nobody sees — worse, it would attach an
 * image whose citation is no longer in the prompt.
 *
 * Everything here is best-effort, in the same spirit as the retrieval that
 * produced the chunks: a companion that has gone away, a source file that
 * moved, a model that cannot see — each results in a text-only answer, never a
 * failed generation.
 */
import { getServices } from '../../../app/services';
import type { RetrievedChunk } from '../../../types/knowledgebase';

/**
 * How many figures may ride along on one run.
 *
 * Two is enough to compare a pair — the question people actually ask of
 * figures — and cheap enough not to dominate the context window at roughly
 * 1600 tokens each. A retrieval that surfaces five figures sends the two
 * best-scoring ones.
 */
export const MAX_RUN_FIGURES = 2;

/** Figures cannot be worth a slow companion; generation is already waiting. */
const FIGURE_TIMEOUT_MS = 8_000;

export interface RunFigure {
  /** Base64 PNG, ready for the request's `images` array. */
  dataBase64: string;
  /** For the sources list: which paper and page this came from. */
  source: string;
  page: number;
  caption: string;
}

/**
 * Fetches images for the figure-bearing chunks among `sources`, best first.
 *
 * `visionModel` is passed through to the companion, which uses it to describe
 * the figure in the background so the *next* search ranks it better. Nothing
 * about this call waits for that.
 */
export async function fetchRunFigures(
  sources: readonly RetrievedChunk[],
  visionModel: string | null,
  signal?: AbortSignal,
): Promise<RunFigure[]> {
  if (visionModel === null) return [];
  const withFigures = sources
    .filter((chunk) => chunk.figure !== undefined)
    .slice(0, MAX_RUN_FIGURES);
  if (withFigures.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FIGURE_TIMEOUT_MS);
  const onAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort);

  try {
    const fetched = await Promise.all(
      withFigures.map(async (chunk) => {
        const figure = chunk.figure;
        if (figure === undefined) return null;
        try {
          const image = await getServices().kb.getFigure(
            chunk.collectionId,
            figure.id,
            visionModel,
            controller.signal,
          );
          return image === null
            ? null
            : {
                dataBase64: image.dataBase64,
                source: image.source,
                page: image.page,
                caption: image.caption,
              };
        } catch {
          return null;
        }
      }),
    );
    return fetched.filter((figure): figure is RunFigure => figure !== null);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
