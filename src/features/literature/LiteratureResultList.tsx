/**
 * Literature results list (DECISIONS.md ADR-029). Per-result rendering lives
 * in `LiteratureResultCard.tsx`; this file is the list shell — grouping,
 * the "what was sent" disclosure, and the summary lines that apply to the
 * whole search rather than one result.
 *
 * **"Not checked" is not "absent".** Stated once per search, not once per
 * card: which sources went unconsulted is a property of what's turned on,
 * the same for every result, so repeating a grey "not checked" badge on
 * every card is exactly the noise the retraction-disclosure banner already
 * solved for one check — the same fix now covers all of them in one place.
 *
 * Low-verification results are collapsed rather than hidden: indexing coverage
 * is skewed toward English-language publishing, so a missing signal is often a
 * missing index rather than a missing standard.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { verificationStatus } from '../../services/literature';
import type { AssessedRecord } from '../../types/literature';
import { useSettingsStore } from '../settings';
import { useLiteratureStore, type RankingMode } from './literature.store';
import { ResultCard } from './LiteratureResultCard';

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  ranking: { color: tokens.colorNeutralForeground3 },
  sent: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  sentQuery: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-word',
    color: tokens.colorNeutralForeground1,
  },
});

// Citation weighting (DECISIONS.md ADR-029, fifth amendment) uses log-scaled
// raw citation counts from OpenAlex when `litCitationImpactWeight > 0`, and
// drops out completely when the weight is set to 0.
const RANKING_LABEL: Record<RankingMode, { base: string; weighted: string }> = {
  semantic: {
    base: 'Ranked against your selection, on this machine.',
    weighted:
      'Ranked against your selection, on this machine, weighted by log-scaled citation count (OpenAlex, when available).',
  },
  lexical: {
    base: 'Ranked by shared words rather than meaning.',
    weighted:
      'Ranked by shared words rather than meaning, weighted by log-scaled citation count (OpenAlex, when available).',
  },
  'source-order': {
    base: "Shown in the source's own order; not ranked against your selection.",
    weighted: "Shown in the source's own order; not ranked against your selection.",
  },
};

/**
 * Which checks ran for *none* of the current results — a property of what's
 * turned on for the whole search, the same for every card. `badgeId` is the
 * id `describeCredibility` gives the corresponding per-card badge, so a
 * search-wide gap can be dropped from every card without also dropping a
 * genuinely per-record one (e.g. the one result with no DOI, while
 * verification is otherwise on).
 */
const SKIPPED_CHECKS = [
  {
    badgeId: 'crossref',
    label: 'retraction/registration',
    skippedFor: (entry: AssessedRecord) =>
      !entry.updates.checked || entry.signals.crossref === null,
  },
  {
    badgeId: 'medline',
    label: 'MEDLINE',
    skippedFor: (entry: AssessedRecord) => entry.signals.pubmed === null,
  },
  {
    badgeId: 'venue',
    label: 'venue',
    skippedFor: (entry: AssessedRecord) => entry.signals.openAlex === null,
  },
] as const;

/**
 * One combined, compact line for every check skipped search-wide — replaces
 * what used to be a full-width warning `MessageBar` for one check
 * (retractions) plus a repeated grey badge per card per check (registration,
 * MEDLINE, venue). A search-wide gap is stated once, not N times, and not at
 * MessageBar size.
 */
function describeSkippedChecks(results: readonly AssessedRecord[]): {
  note: string | null;
  suppressedUncheckedIds: ReadonlySet<string>;
} {
  const skipped = SKIPPED_CHECKS.filter((check) => results.every(check.skippedFor));
  const suppressedUncheckedIds = new Set(skipped.map((check) => check.badgeId));
  if (skipped.length === 0) return { note: null, suppressedUncheckedIds };
  const gaps = skipped.map((check) => check.label).join(' · ');
  return {
    note: `Not checked: ${gaps}. Turn sources on under Settings → Literature to see them.`,
    suppressedUncheckedIds,
  };
}

export function LiteratureResultList(): ReactElement | null {
  const styles = useStyles();
  const [showLimited, setShowLimited] = useState(false);
  const results = useLiteratureStore((state) => state.results);
  const ranking = useLiteratureStore((state) => state.ranking);
  const rankingNote = useLiteratureStore((state) => state.rankingNote);
  const sentQueries = useLiteratureStore((state) => state.sentQueries);
  const [showSent, setShowSent] = useState(false);
  const minVenueCitedness = useSettingsStore((state) => state.litMinVenueCitedness);
  const citationImpactWeight = useSettingsStore((state) => state.litCitationImpactWeight);

  if (results.length === 0) return null;

  const verified = results.filter((entry) => verificationStatus(entry.signals) !== 'limited');
  const limited = results.filter((entry) => verificationStatus(entry.signals) === 'limited');
  const { note: skippedChecksNote, suppressedUncheckedIds } = describeSkippedChecks(results);
  const rankingText =
    citationImpactWeight > 0 ? RANKING_LABEL[ranking].weighted : RANKING_LABEL[ranking].base;

  return (
    <div className={styles.list}>
      {skippedChecksNote === null ? null : (
        <Caption1 className={styles.ranking}>{skippedChecksNote}</Caption1>
      )}

      <Caption1 className={styles.ranking}>{rankingText}</Caption1>

      {sentQueries.length === 0 ? null : (
        <>
          <Button
            appearance="subtle"
            size="small"
            onClick={() => {
              setShowSent((open) => !open);
            }}
          >
            {showSent
              ? 'Hide what was sent'
              : `What was sent to each source (${String(sentQueries.length)})`}
          </Button>
          {showSent ? (
            <div className={styles.sent}>
              <Caption1 className={styles.ranking}>
                Sources do not all speak the same dialect, so the approved query is adapted per
                source. This is exactly what left the machine.
              </Caption1>
              {sentQueries.map((entry) => (
                <div key={entry.source}>
                  <Caption1>
                    <strong>{entry.source}</strong>
                  </Caption1>
                  <div className={styles.sentQuery}>{entry.query}</div>
                  {entry.note === undefined ? null : (
                    <Caption1 className={styles.ranking}>{entry.note}</Caption1>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
      {rankingNote === null ? null : (
        <MessageBar intent="warning">
          <MessageBarBody>{rankingNote}</MessageBarBody>
        </MessageBar>
      )}

      {verified.map((entry, position) => (
        <ResultCard
          key={entry.record.id}
          entry={entry}
          index={position + 1}
          minVenueCitedness={minVenueCitedness}
          suppressedUncheckedIds={suppressedUncheckedIds}
        />
      ))}

      {limited.length === 0 ? null : (
        <>
          <Button
            appearance="subtle"
            onClick={() => {
              setShowLimited((open) => !open);
            }}
          >
            {showLimited
              ? 'Hide results with limited verification'
              : `${String(limited.length)} further results with limited verification`}
          </Button>
          {showLimited ? (
            <>
              <Body1>
                These passed none of the indexing checks. That often means a journal is poorly
                indexed rather than unsound — coverage is uneven — so they are collapsed, not
                discarded.
              </Body1>
              {limited.map((entry, position) => (
                <ResultCard
                  key={entry.record.id}
                  entry={entry}
                  index={verified.length + position + 1}
                  minVenueCitedness={minVenueCitedness}
                  suppressedUncheckedIds={suppressedUncheckedIds}
                />
              ))}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
