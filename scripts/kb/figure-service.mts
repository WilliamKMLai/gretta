/**
 * Producing a figure's pixels and description on demand (DECISIONS.md ADR-036).
 *
 * Indexing records a figure from its caption alone — no canvas, no vision
 * model, effectively free. Everything expensive happens here, the first time
 * something actually asks for a figure, and the result is cached so it never
 * happens twice.
 *
 * The two halves have deliberately different urgency:
 *
 *  - **Pixels** are needed *now*. A generation is waiting on them, and
 *    rendering a page region takes about 11ms.
 *  - **A description** is needed *next time*. It exists to make the figure
 *    findable, not to answer the question in flight — the vision model is
 *    about to look at the actual picture. At a measured ~16 seconds it must
 *    never block a request, so it runs detached and the chunk is re-embedded
 *    when it lands.
 *
 * That split is the whole design. It is why on-demand costs a user nothing
 * they can feel, and why a collection quietly gets better at finding its own
 * figures the more it is used.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { SqliteStore, StoredFigure } from './store.sqlite.mts';
import type { Describer } from './describer.mts';
import type { Embedder } from './embedder.mts';
import { DescribeUnreachableError } from './describer.mts';
import { renderRegion } from './render.mts';
import type { Rect } from './figures.mts';

/** Pixels plus the metadata the pane needs to show and cite a figure. */
export interface FigureImageResult {
  id: string;
  source: string;
  page: number;
  caption: string;
  description: string | null;
  mediaType: string;
  dataBase64: string;
  width: number;
  height: number;
}

/** What `FigureService` needs from a collection; kept narrow for testing. */
export interface FigureContext {
  collectionId: string;
  /** Absolute path of a folder-relative source, or null when it has moved. */
  resolveSource: (source: string) => string | null;
  embedder: Embedder;
  describer: Describer;
  /** Optional abort signal cancelled on collection delete or model change. */
  signal?: AbortSignal | undefined;
  /** Guards detached writes against model changes or collection deletion. */
  canCommit?: (() => boolean) | undefined;
  /** Called after a re-embed so the packed query matrix is not stale. */
  invalidate: () => void;
}

/** Renders a stored figure, caching the bytes. Cheap and synchronous-feeling. */
export async function materializeFigure(
  store: SqliteStore,
  context: FigureContext,
  figure: StoredFigure,
): Promise<FigureImageResult | null> {
  if (figure.bytes !== null && figure.mediaType !== null) {
    return toResult(figure, figure.mediaType, figure.bytes, figure.width ?? 0, figure.height ?? 0);
  }

  const absolute = context.resolveSource(figure.source);
  // The file moved or the folder was unmounted. Not an error worth raising —
  // the caller simply gets no picture and answers from the caption.
  if (absolute === null) return null;

  const rendered = await renderFigure(absolute, figure);
  if (rendered === null) return null;

  store.saveFigureImage(figure.id, rendered);
  return toResult(figure, rendered.mediaType, rendered.bytes, rendered.width, rendered.height);
}

async function renderFigure(
  absolute: string,
  figure: StoredFigure,
): Promise<{ mediaType: string; bytes: Buffer; width: number; height: number } | null> {
  let destroyTask: (() => Promise<void>) | null = null;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await readFile(absolute));
    const task = getDocument({ data, useSystemFonts: true });
    destroyTask = () => task.destroy();
    const doc = await task.promise;
    if (figure.page < 1 || figure.page > doc.numPages) return null;
    const page = await doc.getPage(figure.page);
    const viewport = page.getViewport({ scale: 1 });
    const region = JSON.parse(figure.bbox) as Rect;
    return await renderRegion(page as never, region, viewport.height);
  } catch {
    // A figure that will not render is a missing picture, never a failed query.
    return null;
  } finally {
    if (destroyTask !== null) {
      try {
        await destroyTask();
      } catch {
        // Best-effort pdf.js worker cleanup.
      }
    }
  }
}

/**
 * Describes a figure and folds the result back into its chunk's vector.
 *
 * Never awaited by a request path. Failures are swallowed on purpose: the
 * figure keeps its caption-only embedding, remains retrievable, and the next
 * request tries again — an undescribed figure is a slightly worse search
 * result, not a broken one.
 */
export async function describeFigure(
  store: SqliteStore,
  context: FigureContext,
  figure: StoredFigure,
  imageBase64: string,
): Promise<boolean> {
  let description: string;
  try {
    description = await context.describer.describe(imageBase64, figure.caption, context.signal);
  } catch (error) {
    // Unreachable Ollama and "this model has no vision" both land here. Both
    // are conditions the user fixes in Settings, not failures of this figure.
    if (!(error instanceof DescribeUnreachableError)) return false;
    return false;
  }
  if (description === '') return false;
  if (context.canCommit !== undefined && !context.canCommit()) return false;

  store.saveFigureDescription(figure.id, description, new Date().toISOString());

  // Caption first: it is the authoritative text, and putting it ahead of a
  // generated description keeps the chunk's leading tokens trustworthy.
  const text = `${figure.caption}\n\n${description}`;
  try {
    const [vector] = await context.embedder.embed([text], context.signal);
    if (vector === undefined) return false;
    if (context.canCommit !== undefined && !context.canCommit()) return false;
    store.updateChunkForFigure(figure.id, text, vector);
    context.invalidate();
  } catch {
    // The description is stored either way; only the re-embed was lost, and
    // the next reindex will pick it up.
    return false;
  }
  return true;
}

function toResult(
  figure: StoredFigure,
  mediaType: string,
  bytes: Buffer,
  width: number,
  height: number,
): FigureImageResult {
  return {
    id: figure.id,
    source: figure.source,
    page: figure.page,
    caption: figure.caption,
    description: figure.description,
    mediaType,
    dataBase64: bytes.toString('base64'),
    width,
    height,
  };
}

/** Resolves a folder-relative source against a collection's folders. */
export function sourceResolver(folders: readonly string[]): (source: string) => string | null {
  return (source) => {
    for (const folder of folders) {
      const root = resolve(folder);
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
      const candidate = resolve(root, source);
      if (candidate.startsWith(prefix) && existsSync(candidate)) return candidate;
    }
    return null;
  };
}
