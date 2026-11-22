/**
 * Zod validation for Crossref payloads (ARCHITECTURE.md §13.2; DECISIONS.md
 * ADR-028). External APIs are the least trustworthy input in the system, so
 * nothing from the wire reaches the app untyped.
 *
 * Lenient about fields we do not consume, strict about the ones we do — the
 * same posture as `services/ollama` and `services/knowledgebase`. Almost
 * everything is optional, because Crossref metadata is deposited by twenty
 * thousand members of varying diligence and a missing `container-title` is an
 * ordinary Tuesday, not a parse failure.
 */
import { z } from 'zod';
import type { UpdateType, WorkType } from '../../types/literature';

/**
 * Crossref emits `"date-parts": [[null]]` for a work with no known date. Typing
 * the inner value as a bare number made a single undated paper fail validation
 * — and, before per-item parsing below, take the entire page down with it.
 */
const DateParts = z.object({
  'date-parts': z.array(z.array(z.number().nullable())).optional(),
});

const AuthorSchema = z.object({
  family: z.string().optional(),
  given: z.string().optional(),
  name: z.string().optional(),
});

/**
 * A post-publication update. `source` distinguishes a publisher-deposited
 * notice from one Retraction Watch supplied; ADR-029 shows it, because the
 * provenance of a retraction claim is part of how much weight it deserves.
 */
const UpdateToSchema = z.object({
  DOI: z.string().optional(),
  type: z.string().optional(),
  label: z.string().optional(),
  source: z.string().optional(),
  updated: DateParts.optional(),
});

const WorkSchema = z.object({
  DOI: z.string().optional(),
  title: z.array(z.string()).optional(),
  author: z.array(AuthorSchema).optional(),
  'container-title': z.array(z.string()).optional(),
  issued: DateParts.optional(),
  abstract: z.string().optional(),
  type: z.string().optional(),
  URL: z.string().optional(),
  member: z.string().optional(),
  publisher: z.string().optional(),
  'reference-count': z.number().optional(),
  'is-referenced-by-count': z.number().optional(),
  'update-to': z.array(UpdateToSchema).optional(),
  // Preprint deposits name their server in one of these two, depending on how
  // the deposit was made. Neither is reliably present, so both are read.
  institution: z.array(z.object({ name: z.string().optional() })).optional(),
  'group-title': z.string().optional(),
});

/**
 * `items` is deliberately left as unknown here and validated per element in
 * `parseWorkList`. Validating the array as a unit meant one non-conforming
 * record discarded every other record on the page — a whole search returning
 * empty because a single deposited work was malformed, with nothing to
 * indicate why. Crossref aggregates metadata from twenty thousand members and
 * some of it is wrong; resilience has to be per record.
 */
const MessageListSchema = z.object({
  status: z.string().optional(),
  message: z.object({ items: z.array(z.unknown()).optional() }).optional(),
});

const StrictMessageListSchema = z.object({
  status: z.string().optional(),
  message: z.object({ items: z.array(z.unknown()) }),
});

export type CrossrefWork = z.infer<typeof WorkSchema>;

export function parseWorkList(payload: unknown): CrossrefWork[] {
  const parsed = MessageListSchema.safeParse(payload);
  if (!parsed.success) return [];
  const works: CrossrefWork[] = [];
  for (const item of parsed.data.message?.items ?? []) {
    const work = WorkSchema.safeParse(item);
    if (work.success) works.push(work.data);
  }
  return works;
}

/**
 * Strict envelope variant for retraction checks (`lookupUpdates`): when
 * `message.items` is absent or not an array, returns `null` so callers record
 * `checked: false` rather than a false "checked, nothing found" all-clear
 * (ADR-029). Individual malformed items inside a valid array are still skipped.
 */
export function parseNoticeList(payload: unknown): CrossrefWork[] | null {
  const parsed = StrictMessageListSchema.safeParse(payload);
  if (!parsed.success) return null;
  const works: CrossrefWork[] = [];
  for (const item of parsed.data.message.items) {
    const work = WorkSchema.safeParse(item);
    if (work.success) works.push(work.data);
  }
  return works;
}

/**
 * Crossref's `type` vocabulary mapped onto the domain's. `posted-content` is
 * Crossref's term for a preprint, which ADR-029 labels rather than demotes.
 */
export function toWorkType(raw: string | undefined): WorkType {
  switch (raw) {
    case 'journal-article':
      return 'article';
    case 'posted-content':
      return 'preprint';
    case 'book-chapter':
    case 'book-part':
      return 'chapter';
    case 'dataset':
      return 'dataset';
    case 'journal-issue':
    case 'journal-volume':
      return 'other';
    default:
      return raw === undefined ? 'other' : 'article';
  }
}

/**
 * Crossmark's update vocabulary mapped onto the domain's.
 *
 * The `default` case is load-bearing rather than defensive. Crossref's schema
 * and Retraction Watch's own `RetractionNature` vocabulary are explicitly not
 * the same list, and Retraction Watch maintains a changelog of revisions to its
 * terms. An unrecognised notice therefore becomes `other` — surfaced to the
 * user with its own label intact, but never silently promoted to a retraction
 * warning on the strength of a string nobody has seen before.
 */
export function toUpdateType(raw: string | undefined): UpdateType {
  switch (raw?.toLowerCase().replace(/[\s_]+/gu, '-')) {
    case 'retraction':
      return 'retraction';
    case 'partial-retraction':
      return 'partial-retraction';
    case 'withdrawal':
      return 'withdrawal';
    case 'removal':
      return 'removal';
    case 'expression-of-concern':
      return 'expression-of-concern';
    case 'correction':
    case 'corrigendum':
    case 'erratum':
    case 'addendum':
    case 'clarification':
      return 'correction';
    case 'reinstatement':
      return 'reinstatement';
    default:
      return 'other';
  }
}

/** Flattens Crossref's nested date-parts to an ISO day, when one is present. */
export function toIsoDate(
  parts: { 'date-parts'?: (number | null)[][] | undefined } | undefined,
): string | null {
  const first = parts?.['date-parts']?.[0];
  if (first === undefined || first.length === 0) return null;
  const year = first[0];
  if (typeof year !== 'number') return null;
  const month = typeof first[1] === 'number' ? first[1] : 1;
  const day = typeof first[2] === 'number' ? first[2] : 1;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(year)}-${pad(month)}-${pad(day)}`;
}
