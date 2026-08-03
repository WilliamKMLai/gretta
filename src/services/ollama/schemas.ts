/**
 * Zod validation + normalization for every Ollama payload (ARCHITECTURE.md
 * §7.2, §13.2). Nothing from the wire reaches the app untyped: unary bodies
 * and every single NDJSON line pass through here. Schemas are deliberately
 * lenient about *extra* fields (Ollama adds fields across releases) and
 * strict about the fields we actually consume.
 */
import { z } from 'zod';
import type { GenerationStats } from '../../types/domain';
import type { OllamaModel, OllamaModelDetails } from './client.types';

/** `GET /api/version` */
const VersionSchema = z.object({ version: z.string() });

/** Ollama error bodies and mid-stream error lines: `{ "error": "..." }` */
const ErrorBodySchema = z.object({ error: z.string() });

/**
 * `POST /api/embed`. Ollama returns one vector per input, in input order —
 * order is the only thing tying a vector back to the text it came from, so a
 * length mismatch is treated as a failure by the caller rather than silently
 * zipped.
 */
const EmbedSchema = z.object({ embeddings: z.array(z.array(z.number())) });

const ModelDetailsSchema = z
  .object({
    family: z.string().optional(),
    parameter_size: z.string().optional(),
    quantization_level: z.string().optional(),
  })
  .optional();

/** `GET /api/tags` */
const TagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      size: z.number(),
      modified_at: z.string(),
      details: ModelDetailsSchema,
    }),
  ),
});

/** `POST /api/show` — field availability varies by Ollama version; all optional. */
const ShowSchema = z.object({
  details: ModelDetailsSchema,
  model_info: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.array(z.string()).optional(),
});

/** Nanosecond timing/count fields shared by chat + generate final chunks. */
const StatsFieldsSchema = z.object({
  total_duration: z.number().optional(),
  eval_count: z.number().optional(),
  prompt_eval_count: z.number().optional(),
  eval_duration: z.number().optional(),
});

/** One `POST /api/chat` line (streaming) or body (non-streaming). */
const ChatChunkSchema = z
  .object({
    message: z.object({ content: z.string() }).optional(),
    done: z.boolean(),
  })
  .and(StatsFieldsSchema);

/** One `POST /api/generate` line (streaming) or body (non-streaming). */
const GenerateChunkSchema = z
  .object({
    response: z.string().optional(),
    done: z.boolean(),
  })
  .and(StatsFieldsSchema);

/** Normalized view of one stream line, shared by both endpoints. */
export type ParsedChunk =
  | { kind: 'delta'; content: string }
  | { kind: 'final'; content: string; stats: GenerationStats }
  | { kind: 'server-error'; message: string };

/** Ollama reports nanoseconds; the app speaks milliseconds + tokens/second. */
function toGenerationStats(fields: z.infer<typeof StatsFieldsSchema>): GenerationStats {
  const totalNs = fields.total_duration ?? 0;
  const evalNs = fields.eval_duration ?? 0;
  const evalCount = fields.eval_count ?? 0;
  return {
    totalDurationMs: Math.round(totalNs / 1e6),
    evalCount,
    promptEvalCount: fields.prompt_eval_count ?? 0,
    tokensPerSecond: evalNs > 0 ? Math.round((evalCount / (evalNs / 1e9)) * 10) / 10 : 0,
  };
}

/**
 * Server-sent error lines (`{"error": ...}`) can appear instead of a normal
 * chunk — e.g. out-of-memory mid-generation — so every line checks for the
 * error shape before the endpoint shape.
 */
function parseLine(
  json: unknown,
  schema: typeof ChatChunkSchema | typeof GenerateChunkSchema,
  content: (chunk: z.infer<typeof ChatChunkSchema> & z.infer<typeof GenerateChunkSchema>) => string,
): ParsedChunk {
  const asError = ErrorBodySchema.safeParse(json);
  if (asError.success) return { kind: 'server-error', message: asError.data.error };

  const chunk = schema.parse(json) as z.infer<typeof ChatChunkSchema> &
    z.infer<typeof GenerateChunkSchema>;
  const text = content(chunk);
  return chunk.done
    ? { kind: 'final', content: text, stats: toGenerationStats(chunk) }
    : { kind: 'delta', content: text };
}

/** Throws `ZodError` on shape mismatch — the stream runner maps it. */
export function parseChatLine(json: unknown): ParsedChunk {
  return parseLine(json, ChatChunkSchema, (chunk) => chunk.message?.content ?? '');
}

/** Throws `ZodError` on shape mismatch — the stream runner maps it. */
export function parseGenerateLine(json: unknown): ParsedChunk {
  return parseLine(json, GenerateChunkSchema, (chunk) => chunk.response ?? '');
}

export function parseVersion(json: unknown): { version: string } {
  return VersionSchema.parse(json);
}

export function parseTags(json: unknown): OllamaModel[] {
  return TagsSchema.parse(json).models.map((model) => ({
    name: model.name,
    size: model.size,
    modifiedAt: model.modified_at,
    parameterSize: model.details?.parameter_size ?? null,
    quantization: model.details?.quantization_level ?? null,
  }));
}

/**
 * `model_info` keys are prefixed with the architecture (`llama.context_length`,
 * `qwen2.context_length`, …), so the context window is found by suffix.
 */
export function parseShow(json: unknown): OllamaModelDetails {
  const show = ShowSchema.parse(json);
  let contextLength: number | null = null;
  for (const [key, value] of Object.entries(show.model_info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      contextLength = value;
      break;
    }
  }
  return {
    family: show.details?.family ?? null,
    parameterSize: show.details?.parameter_size ?? null,
    quantizationLevel: show.details?.quantization_level ?? null,
    contextLength,
    capabilities: show.capabilities ?? [],
  };
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

export function parseEmbeddings(payload: unknown): number[][] {
  return EmbedSchema.parse(payload).embeddings;
}
