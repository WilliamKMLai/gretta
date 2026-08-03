/**
 * PubMed payload parsing (ARCHITECTURE.md §13.2; DECISIONS.md ADR-028, ADR-029).
 *
 * PubMed is the only source that reliably carries abstracts — Crossref deposits
 * them for roughly one record in five, and OpenAlex backfill reaches about
 * seven in ten — which matters because ADR-029's local re-ranker embeds title
 * and abstract, and a title alone is thin material. For biomedical work PubMed
 * is what closes that gap.
 *
 * Getting there requires XML. `esummary` speaks JSON but has no abstract;
 * `efetch` has the abstract but speaks XML only. There is a `retmode=text`
 * abstract view, and it was rejected: it returns unstructured prose, discarding
 * publication type (how an editorial is told from a research article) and
 * MEDLINE indexing status — both of which ADR-029 wants as credibility signals.
 * So the dependency buys signal, not merely convenience.
 *
 * `fast-xml-parser` rather than `DOMParser`: ADR-029 closed the `DOMParser`
 * door on the reasoning that reaching for a parser invites someone later to
 * reach for `text/html`. A pure-JS parser with no DOM and no HTML mode cannot
 * be turned into that mistake. Entity expansion is left off, so this cannot be
 * walked into a billion-laughs expansion by a hostile payload.
 */
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import type { Contributor, LiteratureRecord, WorkType } from '../../types/literature';
import { abstractToText } from './jats';

/** `esearch` speaks JSON, so the id list needs no XML at all. */
const ESearchSchema = z.object({
  esearchresult: z.object({ idlist: z.array(z.string()).optional() }).optional(),
});

export function parsePmidList(payload: unknown): string[] {
  const parsed = ESearchSchema.safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.esearchresult?.idlist ?? [];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  trimValues: true,
  // Entity expansion stays off, so a hostile payload cannot be walked into a
  // billion-laughs expansion.
  processEntities: false,
  /**
   * Titles and abstracts are *mixed content* — prose with `<i>`, `<sup>`, and
   * `<sub>` inline. Left to destructure them, the parser splits the text from
   * its inline children and loses the order between them, so
   * `Base editing in <i>primary</i> hepatocytes` came back as
   * "Base editing inhepatocytes": a word silently deleted and the seam closed
   * up. That is worse than a dropped record, because a mangled title still
   * looks like a title.
   *
   * Declaring them stop nodes keeps their inner XML as a raw string, which then
   * goes through `abstractToText` — the same flattener Crossref's JATS uses, and
   * already tested against exactly this kind of markup.
   */
  stopNodes: ['*.ArticleTitle', '*.AbstractText', '*.VernacularTitle'],
});

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a node that may be a bare string or an element with `#text`. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (isRecord(value) && '#text' in value) return textOf(value['#text']);
  return '';
}

/**
 * PubMed publication types, mapped onto the domain's work types.
 *
 * A record usually carries several — "Journal Article" alongside "Review" or
 * "Editorial" — so the most specific wins rather than the first seen. The
 * distinction is a credibility signal in ADR-029, not decoration: an editorial
 * and a randomised trial are not interchangeable evidence, and only PubMed
 * says which is which.
 */
const TYPE_PRECEDENCE: readonly (readonly [string, WorkType])[] = [
  ['Retracted Publication', 'erratum'],
  ['Published Erratum', 'erratum'],
  ['Editorial', 'editorial'],
  ['Comment', 'editorial'],
  ['Letter', 'letter'],
  ['Review', 'review'],
  ['Systematic Review', 'review'],
  ['Preprint', 'preprint'],
  ['Journal Article', 'article'],
];

function toWorkType(types: readonly string[]): WorkType {
  for (const [label, mapped] of TYPE_PRECEDENCE) {
    if (types.includes(label)) return mapped;
  }
  return 'other';
}

/**
 * An abstract split into labelled sections — Background, Methods, Results — is
 * joined back into prose. The labels are kept because they are how a structured
 * abstract reads, and dropping them would merge a conclusion into a method.
 */
function toAbstract(node: unknown): string | null {
  const parts = asArray(isRecord(node) ? node.AbstractText : undefined);
  if (parts.length === 0) return null;

  const sections = parts.map((part) => {
    const body = abstractToText(textOf(part)) ?? '';
    const label = isRecord(part) && typeof part['@Label'] === 'string' ? part['@Label'] : null;
    return label === null || body === '' ? body : `${label}: ${body}`;
  });

  const joined = sections.filter((section) => section !== '').join('\n\n');
  return joined === '' ? null : joined;
}

function toAuthors(node: unknown): Contributor[] {
  return asArray(isRecord(node) ? node.Author : undefined).flatMap((author) => {
    if (!isRecord(author)) return [];
    const family = textOf(author.LastName) || textOf(author.CollectiveName);
    if (family === '') return [];
    const given = textOf(author.ForeName);
    return [{ family, given: given === '' ? null : given }];
  });
}

function toYear(node: unknown): number | null {
  const raw = textOf(isRecord(node) ? node.Year : undefined);
  const year = Number.parseInt(raw, 10);
  return Number.isFinite(year) ? year : null;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function toMonth(node: unknown): number | null {
  const raw = textOf(isRecord(node) ? node.Month : undefined)
    .toLowerCase()
    .slice(0, 3);
  if (raw === '') return null;
  const named = MONTHS[raw];
  if (named !== undefined) return named;
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) ? numeric : null;
}

/** One parsed article, plus the signals only PubMed supplies. */
export interface PubMedArticle {
  record: LiteratureRecord;
  /**
   * True when the citation is MEDLINE-indexed. That is a curation decision by
   * NLM's selection committee, not mere presence in PubMed, which is broader.
   */
  medlineIndexed: boolean;
}

function toArticle(citation: unknown): PubMedArticle | null {
  if (!isRecord(citation)) return null;
  const medline = isRecord(citation.MedlineCitation) ? citation.MedlineCitation : null;
  if (medline === null) return null;

  const article = isRecord(medline.Article) ? medline.Article : null;
  if (article === null) return null;

  const pmid = textOf(medline.PMID);
  const title = abstractToText(textOf(article.ArticleTitle));
  if (pmid === '' || title === null) return null;

  const journal = isRecord(article.Journal) ? article.Journal : null;
  const issue = journal !== null && isRecord(journal.JournalIssue) ? journal.JournalIssue : null;
  const pubDate = issue !== null && isRecord(issue.PubDate) ? issue.PubDate : null;
  const year = toYear(pubDate);

  const ids = asArray(
    isRecord(citation.PubmedData) && isRecord(citation.PubmedData.ArticleIdList)
      ? citation.PubmedData.ArticleIdList.ArticleId
      : undefined,
  );
  const doi =
    ids
      .filter((id): id is Record<string, unknown> => isRecord(id) && id['@IdType'] === 'doi')
      .map((id) => textOf(id))
      .find((value) => value !== '') ?? null;

  const types = asArray(
    isRecord(article.PublicationTypeList) ? article.PublicationTypeList.PublicationType : undefined,
  ).map((type) => textOf(type));

  return {
    record: {
      id: `pubmed:${pmid}`,
      doi,
      pmid,
      arxivId: null,
      openAlexId: null,
      title,
      authors: toAuthors(article.AuthorList),
      containerTitle: journal === null ? null : textOf(journal.Title) || null,
      issued: year === null ? null : { year, month: toMonth(pubDate), day: null },
      abstract: toAbstract(article.Abstract),
      type: toWorkType(types),
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      discoveredVia: 'pubmed',
    },
    // NLM sets this to MEDLINE only once the citation has passed indexing;
    // "PubMed-not-MEDLINE" and "In-Process" are explicitly not the same thing.
    medlineIndexed: textOf(medline['@Status']) === 'MEDLINE',
  };
}

/**
 * Parses an `efetch` PubmedArticleSet.
 *
 * Per article, not per document: one unparseable citation drops itself rather
 * than the page. Crossref taught that lesson expensively — an all-or-nothing
 * parse there meant a single undated record emptied whole searches.
 */
export function parseArticleSet(xml: string): PubMedArticle[] {
  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    return [];
  }
  if (!isRecord(document)) return [];

  const set = isRecord(document.PubmedArticleSet) ? document.PubmedArticleSet : null;
  if (set === null) return [];

  return asArray(set.PubmedArticle)
    .map(toArticle)
    .filter((article): article is PubMedArticle => article !== null);
}
