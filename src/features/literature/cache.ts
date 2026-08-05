/**
 * Literature search result cache (DECISIONS.md ADR-028, "Caching and its own
 * privacy surface").
 *
 * Durable and user-deletable, not an in-memory query cache — ADR-028 requires
 * a real "Clear literature cache and search history" control, and a cache that
 * only lives in memory neither survives the pane reloading (which happens
 * constantly in a Word task pane) nor gives that control anything to delete.
 * It goes through the existing `StorageService` (ADR-006's versioned
 * envelopes), same as settings and history.
 *
 * What is cached is deliberately the *retrieved, enriched* records — signals
 * and update checks included, since fetching those is exactly the network
 * cost this exists to avoid — not the ranking. Re-ranking is local and depends
 * on the selected passage, which can differ between two searches that share a
 * query and sources, so a cache hit re-embeds against the *current* passage
 * (`useLiteratureSearch.ts`) rather than replaying a stored ordering computed
 * for a different one.
 *
 * `listEntries` makes the same data browsable as "recent searches" — ADR-028
 * already called this cache a record of "search history"; this is that
 * history made visible instead of only working invisibly behind the scenes.
 *
 * Re-ranking is skipped outright, not just the network, when the passage
 * matches `passageHash` on the cached entry — an exact repeat (press Search
 * again with nothing changed, or reload from "recent searches" without a new
 * selection) then costs no embedding calls either, which is what actually
 * makes a repeat search feel instant rather than merely spared the network
 * round trip.
 */
import { z } from 'zod';
import type { ZodType } from 'zod';
import { STORAGE_KEYS, storageService } from '../../services/storage';
import type {
  AssessedRecord,
  Contributor,
  CredibilitySignals,
  CrossrefSignals,
  IssuedDate,
  LiteratureRecord,
  OpenAlexSignals,
  PubMedSignals,
  StanceAssessment,
  UpdateStatus,
  WorkUpdate,
} from '../../types/literature';
import type { FailedSource, RankingMode, SourceQuery } from './literature.store';

/** ADR-028: a day is long enough to reward re-visiting a passage, short enough
 * that results don't go stale against a literature that keeps publishing. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bounded rather than unbounded: results carry full abstracts, and
 * `localStorage` is a ~5 MB budget shared with settings, history, and
 * prompts. 20 entries is generous for one writing session (each is a distinct
 * query+source+filter combination, not a distinct search click) while keeping
 * the worst case small relative to that budget.
 */
const MAX_ENTRIES = 20;

const ContributorSchema = z.object({
  family: z.string(),
  given: z.string().nullable(),
}) satisfies ZodType<Contributor>;

const IssuedDateSchema = z.object({
  year: z.number(),
  month: z.number().nullable(),
  day: z.number().nullable(),
}) satisfies ZodType<IssuedDate>;

const WorkTypeSchema = z.enum([
  'article',
  'preprint',
  'review',
  'editorial',
  'letter',
  'erratum',
  'chapter',
  'dataset',
  'other',
]);

const LiteratureSourceIdSchema = z.enum(['pubmed', 'crossref', 'arxiv', 'biorxiv', 'openalex']);

const LiteratureRecordSchema = z.object({
  id: z.string(),
  doi: z.string().nullable(),
  pmid: z.string().nullable(),
  arxivId: z.string().nullable(),
  openAlexId: z.string().nullable(),
  title: z.string(),
  authors: z.array(ContributorSchema),
  containerTitle: z.string().nullable(),
  issued: IssuedDateSchema.nullable(),
  abstract: z.string().nullable(),
  type: WorkTypeSchema,
  url: z.string().nullable(),
  discoveredVia: LiteratureSourceIdSchema,
}) satisfies ZodType<LiteratureRecord>;

const OpenAlexSignalsSchema = z.object({
  venueKnown: z.boolean(),
  venueInDoaj: z.boolean().nullable(),
  venueIsOa: z.boolean().nullable(),
  venueMeanCitedness: z.number().nullable(),
  venueHIndex: z.number().nullable(),
  venueApcUsd: z.number().nullable(),
  fwci: z.number().nullable(),
  citedByPercentileYear: z.number().nullable(),
  citedByCount: z.number().nullable(),
  isParatext: z.boolean().nullable(),
}) satisfies ZodType<OpenAlexSignals>;

const PubMedSignalsSchema = z.object({
  inPubMed: z.boolean(),
  medlineIndexed: z.boolean().nullable(),
}) satisfies ZodType<PubMedSignals>;

const CrossrefSignalsSchema = z.object({
  registered: z.boolean(),
  hasDepositedReferences: z.boolean().nullable(),
  memberName: z.string().nullable(),
}) satisfies ZodType<CrossrefSignals>;

const CredibilitySignalsSchema = z.object({
  openAlex: OpenAlexSignalsSchema.nullable(),
  pubmed: PubMedSignalsSchema.nullable(),
  crossref: CrossrefSignalsSchema.nullable(),
}) satisfies ZodType<CredibilitySignals>;

const UpdateTypeSchema = z.enum([
  'retraction',
  'partial-retraction',
  'withdrawal',
  'removal',
  'expression-of-concern',
  'correction',
  'reinstatement',
  'other',
]);

const WorkUpdateSchema = z.object({
  type: UpdateTypeSchema,
  source: z.string(),
  noticeDoi: z.string().nullable(),
  label: z.string(),
  date: z.string().nullable(),
}) satisfies ZodType<WorkUpdate>;

const UpdateStatusSchema = z.object({
  checked: z.boolean(),
  updates: z.array(WorkUpdateSchema),
}) satisfies ZodType<UpdateStatus>;

const StanceAssessmentSchema = z.object({
  stance: z.enum(['supports', 'contradicts', 'mixed', 'unclear']),
  evidence: z.string(),
  model: z.string(),
  assessedAt: z.string(),
}) satisfies ZodType<StanceAssessment>;

const AssessedRecordSchema = z.object({
  record: LiteratureRecordSchema,
  signals: CredibilitySignalsSchema,
  updates: UpdateStatusSchema,
  relevance: z.number().nullable(),
  stance: StanceAssessmentSchema.nullable(),
  tier: z.enum(['queued', 'verified']),
}) satisfies ZodType<AssessedRecord>;

const SourceQuerySchema = z.object({
  source: z.string(),
  query: z.string(),
  note: z.string().optional(),
}) satisfies ZodType<SourceQuery>;

const FailedSourceSchema = z.object({
  source: z.string(),
  message: z.string(),
}) satisfies ZodType<FailedSource>;

const RankingModeSchema = z.enum([
  'semantic',
  'lexical',
  'source-order',
]) satisfies ZodType<RankingMode>;

const CacheEntrySchema = z.object({
  key: z.string(),
  storedAt: z.string(),
  results: z.array(AssessedRecordSchema),
  ranking: RankingModeSchema,
  hiddenCount: z.number(),
  rankingNote: z.string().nullable(),
  sentQueries: z.array(SourceQuerySchema),
  /**
   * Sources that failed on the search that produced this entry (ADR-032), so
   * reusing it reproduces the same warning rather than presenting a degraded
   * result set as a complete one.
   *
   * Defaulted rather than required: entries written before this field existed
   * must stay readable. A default of `[]` is also the honest reading of
   * them — they were written by a build that could not have recorded a partial
   * failure, because a partial failure was a total one.
   */
  failedSources: z.array(FailedSourceSchema).default([]),
  /**
   * Denormalized copy of what went into `cacheKey`, kept alongside it rather
   * than parsed back out of it — the key's `JSON.stringify` shape is an
   * implementation detail of `cacheKey`, not a format callers should decode.
   * This is what "recent searches" (`listEntries`) displays and offers to
   * reuse.
   */
  query: z.string(),
  sources: z.array(z.string()),
  fromYear: z.number().nullable(),
  resultsPerSource: z.number(),
  /** `hashPassage` of the passage this entry was last ranked against. */
  passageHash: z.string(),
});

const CachePayloadSchema = z.object({ entries: z.array(CacheEntrySchema) });

export type CacheEntry = z.infer<typeof CacheEntrySchema>;
/**
 * The write-side shape. Differs from `CacheEntry` only in that defaulted
 * fields are optional, so a caller that predates a field — or a fixture that
 * does not care about one — still type-checks, and `readCache` fills it in.
 */
type CacheEntryInput = z.input<typeof CacheEntrySchema>;

/**
 * Stable cache key over exactly the inputs that change what would be sent:
 * the normalized query text, the enabled source set (order-independent — a
 * caller must sort or otherwise canonicalize it before passing it in), the
 * year filter, and the per-source result count. Two searches that would fire
 * different requests must not share an entry; this is why every one of those
 * knobs is folded in rather than just the query string.
 */
export function cacheKey(
  normalizedQuery: string,
  enabledSources: readonly string[],
  fromYear: number | null,
  resultsPerSource: number,
): string {
  return JSON.stringify([normalizedQuery, [...enabledSources].sort(), fromYear, resultsPerSource]);
}

/** The `enabledSources` argument `cacheKey` wants, from a `litSources`-shaped record. */
export function enabledSourceKeys(sources: Record<string, boolean>): string[] {
  return Object.entries(sources)
    .filter(([, on]) => on)
    .map(([source]) => source);
}

/**
 * FNV-1a, 32-bit, hex-encoded. Deliberately non-cryptographic — this exists
 * only to detect whether the current passage matches the one a cache entry
 * was last ranked against, not to protect anything, and a collision merely
 * costs an unnecessary re-rank rather than a wrong answer. Hashing rather
 * than storing the passage itself keeps it out of `localStorage`: ADR-028
 * already keeps the passage out of every other piece of persisted state, and
 * this cache shouldn't become the one place manuscript text lands in it.
 */
export function hashPassage(passage: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < passage.length; i += 1) {
    hash ^= passage.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

async function readPayload(): Promise<CacheEntry[]> {
  const payload = await storageService.get(STORAGE_KEYS.literatureCache, CachePayloadSchema);
  return payload?.entries ?? [];
}

async function writePayload(entries: readonly CacheEntryInput[]): Promise<void> {
  await storageService.set(STORAGE_KEYS.literatureCache, { entries });
}

/**
 * Reads a cache entry. A miss — key absent, entry expired, or the stored
 * payload no longer matches the schema (a shape from an older build) — yields
 * `null` rather than throwing, so a corrupt cache degrades to an ordinary
 * network search instead of a crash. An expired entry is dropped from storage
 * on the way out, so it doesn't count against `MAX_ENTRIES` for the write that
 * follows the resulting network search.
 */
export async function readCache(key: string): Promise<CacheEntry | null> {
  const entries = await readPayload();
  const entry = entries.find((candidate) => candidate.key === key);
  if (entry === undefined) return null;

  const age = Date.now() - Date.parse(entry.storedAt);
  if (!Number.isFinite(age) || age > TTL_MS) {
    await writePayload(entries.filter((candidate) => candidate.key !== key));
    return null;
  }
  return entry;
}

/**
 * Writes an entry, replacing any existing one for the same key and evicting
 * the oldest entries past `MAX_ENTRIES`. Storage-quota failures propagate to
 * the caller, which treats caching as best-effort and does not let a full
 * `localStorage` fail a search that already succeeded.
 */
export async function writeCache(
  key: string,
  payload: Omit<CacheEntryInput, 'key' | 'storedAt'>,
): Promise<void> {
  const existing = await readPayload();
  const withoutKey = existing.filter((candidate) => candidate.key !== key);
  const next = [...withoutKey, { key, storedAt: new Date().toISOString(), ...payload }];
  while (next.length > MAX_ENTRIES) next.shift();
  await writePayload(next);
}

/** Deletes the cache outright — a real removal, not a tombstone or a flag. */
export async function clearCache(): Promise<void> {
  await storageService.remove(STORAGE_KEYS.literatureCache);
}

/**
 * Lists cached searches newest-first, for a "recent searches" UI — the same
 * data `readCache` uses, just browsable rather than looked up by key. Expired
 * entries are pruned from storage on the way out, same as `readCache`, so a
 * list rendered right after this never shows something a lookup would then
 * treat as a miss.
 */
export async function listEntries(): Promise<CacheEntry[]> {
  const entries = await readPayload();
  const now = Date.now();
  const live = entries.filter((entry) => {
    const age = now - Date.parse(entry.storedAt);
    return Number.isFinite(age) && age <= TTL_MS;
  });
  if (live.length !== entries.length) await writePayload(live);
  return [...live].sort((a, b) => Date.parse(b.storedAt) - Date.parse(a.storedAt));
}
