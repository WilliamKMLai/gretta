/**
 * Persistence schema for generation history (ARCHITECTURE.md §6, §13.2;
 * ADR-021).
 *
 * The `.transform()` steps rebuild domain objects with conditional spreads so
 * optional fields are truly absent (not `undefined`) — required under
 * `exactOptionalPropertyTypes` and keeps persisted JSON free of nulls.
 */
import { z } from 'zod';
import type { ZodType } from 'zod';
import type { GenerationRecord } from '../../types/domain';

const generationStatsSchema = z.object({
  totalDurationMs: z.number(),
  evalCount: z.number(),
  promptEvalCount: z.number(),
  tokensPerSecond: z.number(),
});

const retrievedChunkSchema = z.object({
  collectionId: z.string(),
  source: z.string(),
  locator: z.object({ page: z.number().nullable(), paragraph: z.number().nullable() }),
  text: z.string(),
  score: z.number(),
});

const appliedActionSchema = z.object({
  kind: z.enum(['insert', 'replace', 'append', 'comment']),
  at: z.string(),
});

const generationRecordSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    prompt: z.string(),
    response: z.string(),
    model: z.string(),
    outcome: z.enum(['completed', 'cancelled', 'error']),
    templateId: z.string().optional(),
    templateName: z.string().optional(),
    contextSource: z.enum(['none', 'selection', 'paragraph', 'document']).optional(),
    stats: generationStatsSchema.optional(),
    sources: z.array(retrievedChunkSchema).optional(),
    applied: appliedActionSchema.optional(),
  })
  .transform((value): GenerationRecord => ({
    id: value.id,
    createdAt: value.createdAt,
    prompt: value.prompt,
    response: value.response,
    model: value.model,
    outcome: value.outcome,
    ...(value.templateId !== undefined ? { templateId: value.templateId } : {}),
    ...(value.templateName !== undefined ? { templateName: value.templateName } : {}),
    ...(value.contextSource !== undefined ? { contextSource: value.contextSource } : {}),
    ...(value.stats !== undefined ? { stats: value.stats } : {}),
    ...(value.sources !== undefined ? { sources: value.sources } : {}),
    ...(value.applied !== undefined ? { applied: value.applied } : {}),
  }));

export interface PersistedHistory {
  records: GenerationRecord[];
}

export const persistedHistorySchema = z.object({
  records: z.array(generationRecordSchema),
}) satisfies ZodType<PersistedHistory>;
