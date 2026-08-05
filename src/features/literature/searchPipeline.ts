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
  applyRankAdjustments,
  embeddableText,
  rankByOverlap,
  rankByRelevance,
  verificationStatus,
} from '../../services/literature';
import type {
  AssessedRecord,
  CredibilitySignals,
  LiteratureRecord,
  WorkType,
} from '../../types/literature';
import { hashPassage, writeCache } from './cache';
import type { CacheEntry } from './cache';
import type { FailedSource, RankingMode, SourceQuery } from './literature.store';

/**
 * Citation count at which the impact curve reaches its ceiling. Above this,
 * more citations buy nothing: the difference between 200 and 2,000 citations
 * is a difference in field size and age, not in whether the paper is worth
 * putting in front of someone.
 */
const IMPACT_SATURATION = 200;

/**
 * Impact from the **raw** citation count, log-scaled (DECISIONS.md ADR-029,
 * fifth amendment). 0 — neutral, not penalised — when OpenAlex was never
 * consulted, and 0 for a genuine zero count.
 *
 * This used to read `citedByPercentileYear`, on the reasoning that an
 * age-normalised measure avoids rewarding papers for being old. That was
 * right in principle and wrong in practice, in a way three prior amendments
 * to ADR-029 tuned around without hitting: OpenAlex leaves that percentile
 * **null** for a large share of preprints and recent deposits, and the old
 * code mapped null to 0. User-reported: BoltzGen's 2025 preprint with 59
 * citations scored 0 impact, a 2026 Figshare deposit with none scored 0 too,
 * and the whole boost silently cancelled to nothing on the results where it
 * was supposed to matter most. A signal that is absent exactly where it is
 * needed is not a conservative signal, it is a broken one.
 *
 * Log scaling is what makes the raw count safe to use despite the age bias.
 * The curve is steep where the evidence actually is — the step from 0 to 10
 * citations carries most of the available information — and almost flat where
 * age dominates: a 500-citation 2015 paper scores 1.0 against a 59-citation
 * 2025 preprint's 0.77, a 0.23 separation rather than the 8x their raw counts
 * would suggest.
 */
function citationImpact(entry: AssessedRecord): number {
  const openAlex = entry.signals.openAlex;
  // Falsy covers all three "no impact" cases at once: no OpenAlex signal, a
  // null count, and a zero count. Zero citations is zero impact,
  // unconditionally — the rule ADR-029's third amendment established.
  if (!openAlex?.citedByCount) return 0;
  const scaled = Math.log10(1 + openAlex.citedByCount) / Math.log10(1 + IMPACT_SATURATION);
  return Math.min(1, scaled);
}

/**
 * How far each kind of non-article record is pushed down (DECISIONS.md
 * ADR-029, sixth amendment). Subtracted from a relevance score that lives in
 * roughly 0..1, so 1 is "below everything else" and 0.5 is "loses to any
 * decently matching article, but a strongly matching one can still surface".
 *
 * Provisional numbers, in the same spirit as `litMinVenueCitedness` before it
 * got a control: chosen against one reported result set, not a measured
 * corpus. Deliberately *not* a setting yet — a knob per record type is more
 * configuration than an academic writing pane should ask anyone to reason
 * about, and if these prove wrong the fix is better numbers, or one control,
 * not five.
 */
const TYPE_PENALTIES: Partial<Record<WorkType, number>> = {
  /*
   * Light, and deliberately much lighter than the rest. An editorial,
   * commentary, or perspective is a real, citable piece of scholarly writing —
   * often exactly what someone wants when looking for how a field received a
   * result. This is a tie-break ("all else equal, prefer the research
   * article"), not a demotion.
   *
   * It started at 0.75, which was wrong: that number was aimed at OpenAlex
   * folding its `paratext` type into `editorial`, and so charged every real
   * editorial for a mapping artifact. `isParatext` below already catches
   * paratext directly, at full strength, and it is the assertion that actually
   * means "not a research work". The residual gap is narrow and worth naming:
   * an OpenAlex record typed `paratext` that was never enriched — enrichment
   * off, or its DOI unmatched — arrives with no signals and is judged on this
   * number alone. Front matter carries almost no abstract text to embed, so it
   * rarely ranks highly enough for that to matter.
   */
  editorial: 0.2,
  /*
   * The reported case: a 2026 Figshare deposit with zero citations sitting at
   * position 4 above the preprint it accompanies. Supplementary data lands
   * here from both Crossref (`dataset`) and OpenAlex (`dataset`).
   */
  dataset: 0.5,
  /*
   * An erratum notice outranking the paper it corrects is never what was
   * wanted — and the correction is already surfaced *on* that paper as an
   * update badge (ADR-029), so demoting the standalone notice loses nothing.
   */
  erratum: 0.5,
};

/**
 * Demotes records that are not the research work being looked for.
 *
 * Never a filter. Dropping records outright would break the same provenance
 * guarantee that keeps knowledge-base indexing from truncating at the capacity
 * ceiling: a result that is absent cannot be judged, and a user searching for
 * a dataset on purpose would be told, wrongly, that none exists. These sink to
 * the bottom of the list and stay reachable.
 *
 * `isParatext` is consulted directly rather than trusted to the type mapping,
 * because it is a distinct assertion — OpenAlex sets it on records it typed as
 * something else — and it is the strongest available statement that a record
 * is not a research work at all.
 */
function supplementaryPenalty(entry: AssessedRecord): number {
  if (entry.signals.openAlex?.isParatext === true) return 1;
  return TYPE_PENALTIES[entry.record.type] ?? 0;
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
        ordered: applyRankAdjustments(withRelevance, {
          impact: citationImpact,
          impactWeight: settings.litCitationImpactWeight,
          penalty: supplementaryPenalty,
        }),
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
    ordered: applyRankAdjustments(withRelevance, {
      impact: citationImpact,
      impactWeight: settings.litCitationImpactWeight,
      penalty: supplementaryPenalty,
    }),
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
  failedSources: FailedSource[],
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
    failedSources: FailedSource[],
  ) => void,
): Promise<{
  ordered: AssessedRecord[];
  ranking: RankingMode;
  note: string | null;
  hidden: number;
}> {
  const { ordered, ranking, note } = await rank(assessed, passage, ollama, settings, controller);
  const hidden = ordered.filter((entry) => verificationStatus(entry.signals) === 'limited').length;
  setResults(ordered, ranking, hidden, note, sentQueries, failedSources);
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
    failedSources: FailedSource[],
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
      cached.failedSources,
    );
    return;
  }

  const { ordered, ranking, note, hidden } = await deliverRanked(
    cached.results,
    cached.sentQueries,
    cached.failedSources,
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
    failedSources: cached.failedSources,
    query: cached.query,
    sources: cached.sources,
    fromYear: cached.fromYear,
    resultsPerSource: cached.resultsPerSource,
    passageHash,
  }).catch(() => undefined);
}
