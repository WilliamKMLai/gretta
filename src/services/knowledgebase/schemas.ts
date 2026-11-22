/**
 * Zod validation for every knowledge-base companion payload (ARCHITECTURE.md
 * §7, §13.2; DECISIONS.md ADR-020). Nothing from the wire reaches the app
 * untyped. Like the Ollama schemas these are lenient about extra fields and
 * strict about the fields we consume.
 */
import { z } from 'zod';
import type {
  CollectionStatus,
  FigureImage,
  KnowledgeBaseHealth,
  PickFolderResult,
  RetrievedChunk,
} from '../../types/knowledgebase';

const PhaseSchema = z.enum([
  'disabled',
  'idle',
  'scanning',
  'indexing',
  'ready',
  'ollama-unreachable',
  'error',
]);

const HealthSchema = z.object({
  name: z.literal('gretta-kb'),
  version: z.string(),
  ok: z.boolean(),
  // Optional: an older companion will not report where its index lives.
  dataDir: z.string().optional(),
  // Optional for the same reason, and absent reads as "no dialog" (ADR-033).
  pickFolder: z.boolean().optional(),
  // Absent reads as false: an older companion never offers figures (ADR-036).
  describeFigures: z.boolean().optional(),
});

/**
 * A discriminated union rather than one object with optional fields, so an
 * `ok: false` payload cannot carry a `path` and a success cannot omit one
 * (ADR-033). `message` is only ever attached to a real failure.
 */
const PickFolderSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string().min(1) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['cancelled', 'unsupported', 'busy', 'failed']),
    message: z.string().optional(),
  }),
]) satisfies z.ZodType<PickFolderResult>;

const CollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  folders: z.array(z.string()),
  embeddingModel: z.string(),
  phase: PhaseSchema,
  fileCount: z.number(),
  chunkCount: z.number(),
  maxChunks: z.number(),
  capacityPct: z.number(),
  overCapacity: z.boolean(),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  lastIndexedAt: z.string().nullable(),
  message: z.string().nullable(),
  // Defaulted rather than optional: a companion predating ADR-036 reports no
  // figure fields, and the pane should read that as "no figures", not crash.
  indexFigures: z.boolean().default(false),
  figureCount: z.number().default(0),
  describedFigureCount: z.number().default(0),
});

const CollectionsSchema = z.object({ collections: z.array(CollectionSchema) });

const ChunkSchema = z.object({
  collectionId: z.string(),
  source: z.string(),
  locator: z.object({
    page: z.number().nullable(),
    paragraph: z.number().nullable(),
  }),
  text: z.string(),
  score: z.number(),
  figure: z.object({ id: z.string(), caption: z.string(), described: z.boolean() }).optional(),
});

const QuerySchema = z.object({ chunks: z.array(ChunkSchema) });

const FigureImageSchema = z.object({
  id: z.string(),
  source: z.string(),
  page: z.number(),
  caption: z.string(),
  description: z.string().nullable(),
  mediaType: z.string(),
  dataBase64: z.string().min(1),
  width: z.number(),
  height: z.number(),
}) satisfies z.ZodType<FigureImage>;

/** Companion error bodies: `{ "error": "..." }`. */
const ErrorBodySchema = z.object({ error: z.string() });

export function parseHealth(json: unknown): KnowledgeBaseHealth {
  return HealthSchema.parse(json);
}

export function parseCollections(json: unknown): CollectionStatus[] {
  return CollectionsSchema.parse(json).collections;
}

export function parseCollection(json: unknown): CollectionStatus {
  return CollectionSchema.parse(json);
}

export function parsePickFolder(json: unknown): PickFolderResult {
  return PickFolderSchema.parse(json);
}

export function parseFigureImage(json: unknown): FigureImage {
  return FigureImageSchema.parse(json);
}

export function parseQuery(json: unknown): RetrievedChunk[] {
  return QuerySchema.parse(json).chunks;
}

/** Best-effort extraction of `{"error": "..."}` from a failed response body. */
export function tryParseErrorBody(text: string): string | null {
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}
