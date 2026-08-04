/**
 * Record assembly and local relevance re-ranking (DECISIONS.md ADR-028,
 * ADR-029).
 *
 * Split out of `useLiteratureSearch.ts` to keep that file under the file-size
 * convention — this half is plain, React-free logic shared by the network
 * path and the cache-hit path: a cache hit re-ranks the stored,
 * already-enriched records against the *current* passage rather than
 * replaying a stored ordering computed for a possibly different one.
 */
import { getServices } from '../../app/services';
import {
  applyImpactBoost,
  embeddableText,
  rankByOverlap,
  rankByRelevance,
  verificationStatus,
} from '../../services/literature';
import type { AssessedRecord, CredibilitySignals, LiteratureRecord } from '../../types/literature';
import { hashPassage, writeCache } from './cache';
import type { CacheEntry } from './cache';
import type { RankingMode, SourceQuery } from './literature.store';

/**
 * Age-adjusted (`citedByPercentileYear`, not the raw count `describeCredibility`
 * shows) so a paper is compared against others from its own year rather than
 * penalised for being recent — the exact bias ADR-029 originally cited for
 * excluding citations from ranking altogether. 0 — neutral, not
 * penalised — when OpenAlex was never consulted for this record.
 *
 * User-reported and confirmed: a brand-new paper with *zero* citations still
 * got a nontrivial boost, enough to outrank an established paper from the
 * previous year with dozens. Cause is a percentile artifact, not a bug in the
 * boost math — early in a cohort year, most papers also have zero citations
 * yet, so "percentile of papers with this many citations or fewer" assigns
 * every 0-citation paper the percentile of that entire tied mass, which can
 * be large. A percentile is only informative once a paper has actually been
 * cited at all; zero citations means zero demonstrated impact, full stop,
 * regardless of what OpenAlex's percentile says about that empty cohort.
 */
function citationImpact(entry: AssessedRecord): number {
  const openAlex = entry.signals.openAlex;
  // Falsy covers all three "no impact" cases at once: no OpenAlex signal, a
  // null count, and a zero count.
  if (!openAlex?.citedByCount) return 0;
  const percentile = openAlex.citedByPercentileYear;
  return percentile === null ? 0 : percentile / 100;
}

export function emptySignals(): CredibilitySignals {
  return { openAlex: null, pubmed: null, crossref: null };
}

/** Lowercases, strips punctuation, and collapses whitespace, for matching the
 * same title across sources that assign it different DOIs. */
function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Deduplicates across sources, first by DOI, then by normalized title.
 *
 * DOI alone is not enough: user-reported, a single preprint cross-listed on
 * Open MIND and twice on Figshare — three DOI-bearing deposits of the same
 * work — occupied three ranked positions and pushed the actual paper down to
 * a fourth. Repository mirrors of the same preprint are routine, each with
 * its own DOI, so a DOI-only key cannot see they are the same work.
 *
 * Both passes prefer the record with an abstract, same rationale as before:
 * PubMed carries abstracts far more often than Crossref, so when two records
 * describe the same paper, keep whichever actually has text to embed. A
 * blank-title record is never merged with another blank-titled one — falls
 * back to its own id — since an empty key would collapse unrelated records
 * that happen to both be missing a title.
 */
export function mergeRecords(groups: readonly LiteratureRecord[][]): LiteratureRecord[] {
  const byDoi = new Map<string, LiteratureRecord>();
  for (const group of groups) {
    for (const record of group) {
      const key = record.doi?.toLowerCase() ?? record.id;
      const existing = byDoi.get(key);
      if (existing === undefined) {
        byDoi.set(key, record);
        continue;
      }
      if (existing.abstract === null && record.abstract !== null) {
        byDoi.set(key, { ...record, doi: record.doi ?? existing.doi });
      }
    }
  }

  const byTitle = new Map<string, LiteratureRecord>();
  for (const record of byDoi.values()) {
    const normalized = normalizedTitle(record.title);
    const key = normalized === '' ? record.id : normalized;
    const existing = byTitle.get(key);
    if (existing === undefined || (existing.abstract === null && record.abstract !== null)) {
      byTitle.set(key, record);
    }
  }
  return [...byTitle.values()];
}

/**
 * Ranks by embeddings when they are available, by lexical overlap when they are
 * not, and reports *why* it fell back.
 *
 * The reason used to be swallowed by a bare `catch`, so a user whose embedding
 * model was simply set to something they had not pulled was told "no embedding
 * model available" — true in effect, useless as a diagnosis, and easy to read
 * as a bug in the feature rather than a setting to change. The failure is
 * expected and survivable; being vague about it is not.
 */
export async function rank(
  assessed: readonly AssessedRecord[],
  passage: string,
  ollama: ReturnType<typeof getServices>['ollama'],
  settings: { defaultEmbeddingModel: string; litCitationImpactWeight: number },
  controller: AbortController,
): Promise<{ ordered: AssessedRecord[]; ranking: RankingMode; note: string | null }> {
  const texts = assessed.map((entry) => embeddableText(entry.record));
  const model = settings.defaultEmbeddingModel;
  let note: string;

  try {
    const vectors = await ollama.embed(model, [passage, ...texts], controller.signal);
    const [passageVector, ...candidateVectors] = vectors;

    if (passageVector !== undefined && candidateVectors.length === assessed.length) {
      const ranked = rankByRelevance(
        passageVector,
        assessed.map((entry, index) => ({
          payload: entry,
          embedding: candidateVectors[index] ?? [],
        })),
      );
      const withRelevance = ranked.map((entry) => ({
        ...entry.payload,
        relevance: entry.relevance,
      }));
      return {
        ordered: applyImpactBoost(withRelevance, citationImpact, settings.litCitationImpactWeight),
        ranking: 'semantic',
        note: null,
      };
    }
    note = `${model} returned an unexpected number of vectors.`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    note = `Could not embed with ${model} — ${detail} Check the embedding model under Settings → Connection; it must be an embedding model you have pulled.`;
  }

  const ranked = rankByOverlap(
    passage,
    assessed.map((entry, index) => ({ payload: entry, text: texts[index] ?? '' })),
  );
  const withRelevance = ranked.map((entry) => ({ ...entry.payload, relevance: entry.relevance }));
  return {
    ordered: applyImpactBoost(withRelevance, citationImpact, settings.litCitationImpactWeight),
    ranking: 'lexical',
    note,
  };
}

/**
 * Ranks a set of assessed records against the passage, derives the
 * hidden-by-verification count, and delivers both to the store. Shared by the
 * cache-hit and network paths in `search()` so a hit is scored exactly the way
 * a fresh search would be, just without the network calls that produced the
 * records in the first place.
 */
export async function deliverRanked(
  assessed: readonly AssessedRecord[],
  sentQueries: SourceQuery[],
  passage: string,
  ollama: ReturnType<typeof getServices>['ollama'],
  settings: { defaultEmbeddingModel: string; litCitationImpactWeight: number },
  controller: AbortController,
  setResults: (
    results: AssessedRecord[],
    ranking: RankingMode,
    hiddenCount: number,
    rankingNote: string | null,
    sentQueries: SourceQuery[],
  ) => void,
): Promise<{
  ordered: AssessedRecord[];
  ranking: RankingMode;
  note: string | null;
  hidden: number;
}> {
  const { ordered, ranking, note } = await rank(assessed, passage, ollama, settings, controller);
  const hidden = ordered.filter((entry) => verificationStatus(entry.signals) === 'limited').length;
  setResults(ordered, ranking, hidden, note, sentQueries);
  return { ordered, ranking, note, hidden };
}

/**
 * Resolves a cache hit against the *current* passage. When it matches the
 * passage the entry was last ranked against, the stored ordering is delivered
 * as-is — no embedding calls, which is what makes an exact repeat search
 * actually instant rather than merely spared the network round trip. A
 * changed passage still needs a real re-rank, since the ordering is only
 * valid for the passage that produced it — the re-ranked result is then
 * written back under `cacheEntryKey` so the *next* repeat is the fast path
 * too. Writing is best-effort, same as a fresh search's cache write.
 */
export async function resolveCacheHit(
  cacheEntryKey: string,
  cached: CacheEntry,
  passage: string,
  ollama: ReturnType<typeof getServices>['ollama'],
  settings: { defaultEmbeddingModel: string; litCitationImpactWeight: number },
  controller: AbortController,
  setResults: (
    results: AssessedRecord[],
    ranking: RankingMode,
    hiddenCount: number,
    rankingNote: string | null,
    sentQueries: SourceQuery[],
  ) => void,
): Promise<void> {
  const passageHash = hashPassage(passage);
  if (passageHash === cached.passageHash) {
    setResults(
      cached.results,
      cached.ranking,
      cached.hiddenCount,
      cached.rankingNote,
      cached.sentQueries,
    );
    return;
  }

  const { ordered, ranking, note, hidden } = await deliverRanked(
    cached.results,
    cached.sentQueries,
    passage,
    ollama,
    settings,
    controller,
    setResults,
  );
  await writeCache(cacheEntryKey, {
    results: ordered,
    ranking,
    hiddenCount: hidden,
    rankingNote: note,
    sentQueries: cached.sentQueries,
    query: cached.query,
    sources: cached.sources,
    fromYear: cached.fromYear,
    resultsPerSource: cached.resultsPerSource,
    passageHash,
  }).catch(() => undefined);
}
