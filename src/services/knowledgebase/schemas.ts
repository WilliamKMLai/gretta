/**
 * Zod validation for every knowledge-base companion payload (ARCHITECTURE.md
 * §7, §13.2; DECISIONS.md ADR-020). Nothing from the wire reaches the app
 * untyped. Like the Ollama schemas these are lenient about extra fields and
 * strict about the fields we consume.
 */
import { z } from 'zod';
import type {
  CollectionStatus,
  KnowledgeBaseHealth,
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
});

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
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  lastIndexedAt: z.string().nullable(),
  message: z.string().nullable(),
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
});

const QuerySchema = z.object({ chunks: z.array(ChunkSchema) });

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
