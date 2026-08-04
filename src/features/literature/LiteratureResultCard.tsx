/**
 * One literature result card (DECISIONS.md ADR-029). Split out of
 * `LiteratureResultList.tsx` to keep that file under the file-size
 * convention.
 *
 * Two rules from that ADR are visible here rather than merely honoured by it.
 *
 * - **Retraction warnings are exempt from everything.** They render above the
 *   title on every result, including ones inside the collapsed
 *   limited-verification group. A warning you can miss by not expanding
 *   something is not a warning.
 * - **Signals are shown, never summed.** Badges carry their own tooltip saying
 *   what the check was and where it came from. There is no score anywhere.
 */
import type { ReactElement } from 'react';
import {
  Badge,
  Caption1,
  Link,
  MessageBar,
  MessageBarBody,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { assessUpdates, describeCredibility } from '../../services/literature';
import type { AssessedRecord } from '../../types/literature';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalXS },
  // Tabular figures so a two-digit number doesn't nudge the title left of a
  // one-digit one in the list above or below it.
  number: {
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },
  meta: { color: tokens.colorNeutralForeground3 },
  // Pulled out of the generic badge row and styled distinctly — a raw
  // citation count is what researchers scan for first, and it read as just
  // another grey pill when it sat among the credibility badges below.
  citations: { color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  abstract: {
    color: tokens.colorNeutralForeground2,
    maxHeight: '5.5em',
    overflow: 'hidden',
  },
});

const TONE_APPEARANCE = {
  positive: 'success',
  neutral: 'informative',
  caution: 'warning',
  unchecked: 'subtle',
} as const;

function authorLine(record: AssessedRecord['record']): string {
  const names = record.authors.map((author) => author.family).filter((name) => name !== '');
  if (names.length === 0) return '';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} et al.`;
}

export function ResultCard({
  entry,
  index,
  minVenueCitedness,
  suppressedUncheckedIds,
}: {
  entry: AssessedRecord;
  /** 1-based position in the full result list, verified and limited combined
   * — a stable number to refer to a specific result by, independent of
   * whether the limited-verification group is expanded. */
  index: number;
  minVenueCitedness: number;
  /**
   * Badge ids already named once, search-wide, in the list's
   * "Not checked: …" summary line — drop only these from this card. A check
   * that ran for every *other* result but not this one (e.g. this is the one
   * record with no DOI) is not in this set, and still gets its own
   * "not checked" badge here: that gap is a property of this record, not of
   * the search, and stating it only search-wide would hide it entirely.
   */
  suppressedUncheckedIds: ReadonlySet<string>;
}): ReactElement {
  const styles = useStyles();
  const { record, signals, updates } = entry;
  const assessment = assessUpdates(updates);
  const badges = describeCredibility(signals, minVenueCitedness).filter(
    (badge) =>
      badge.id !== 'citations' &&
      !(badge.tone === 'unchecked' && suppressedUncheckedIds.has(badge.id)),
  );
  const year = record.issued?.year;
  const citedByCount = signals.openAlex?.citedByCount ?? null;

  return (
    <div className={styles.card}>
      {assessment.blocking.map((update) => (
        <MessageBar
          key={`${update.type}-${update.noticeDoi ?? update.label}`}
          intent={assessment.standsRetracted ? 'error' : 'warning'}
        >
          <MessageBarBody>
            <strong>{update.type.replace(/-/gu, ' ')}</strong>
            {update.date === null ? '' : ` (${update.date})`}
            {assessment.standsRetracted ? '' : ' — later reinstated'}
            {update.noticeDoi === null ? null : (
              <>
                {' · '}
                <Link href={`https://doi.org/${update.noticeDoi}`} target="_blank">
                  read the notice
                </Link>
              </>
            )}
          </MessageBarBody>
        </MessageBar>
      ))}

      <div className={styles.titleRow}>
        <Caption1 className={styles.number}>[{index}]</Caption1>
        <Subtitle2>
          {record.url === null ? (
            record.title
          ) : (
            // Opens in the system browser: navigating the pane would discard
            // state and put a third-party page inside a trusted frame (ADR-028).
            <Link href={record.url} target="_blank" rel="noreferrer">
              {record.title}
            </Link>
          )}
        </Subtitle2>
      </div>

      <Caption1 className={styles.meta}>
        {[authorLine(record), record.containerTitle, year === undefined ? null : String(year)]
          .filter((part) => part !== null && part !== '')
          .join(' · ')}
        {record.type === 'preprint' ? ' · Preprint — not peer reviewed' : ''}
      </Caption1>

      {citedByCount === null ? null : (
        <Caption1 className={styles.citations}>
          {citedByCount.toLocaleString()} citation{citedByCount === 1 ? '' : 's'}
        </Caption1>
      )}

      {record.abstract === null ? null : (
        <Caption1 className={styles.abstract}>{record.abstract}</Caption1>
      )}

      <div className={styles.badges}>
        {badges.map((badge) => (
          <Badge
            key={badge.id}
            appearance="tint"
            color={TONE_APPEARANCE[badge.tone]}
            title={badge.detail}
          >
            {badge.label}
          </Badge>
        ))}
      </div>
    </div>
  );
}
