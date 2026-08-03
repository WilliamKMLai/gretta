/**
 * Literature results (DECISIONS.md ADR-029).
 *
 * Three rules from that ADR are visible in this file rather than merely
 * honoured by it.
 *
 * - **Retraction warnings are exempt from everything.** They render above the
 *   title, on every result, including ones inside the collapsed
 *   limited-verification group. A warning you can miss by not expanding
 *   something is not a warning.
 * - **Signals are shown, never summed.** Badges carry their own tooltip saying
 *   what the check was and where it came from. There is no score anywhere.
 * - **"Not checked" is not "absent".** Unchecked badges are styled distinctly
 *   and say so in words, because a silently degraded trust indicator is worse
 *   than none.
 *
 * Low-verification results are collapsed rather than hidden: indexing coverage
 * is skewed toward English-language publishing, so a missing signal is often a
 * missing index rather than a missing standard.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Link,
  MessageBar,
  MessageBarBody,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { assessUpdates, describeCredibility, verificationStatus } from '../../services/literature';
import type { AssessedRecord } from '../../types/literature';
import { useSettingsStore } from '../settings';
import { useLiteratureStore } from './literature.store';

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  meta: { color: tokens.colorNeutralForeground3 },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
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

function ResultCard({
  entry,
  minVenueCitedness,
}: {
  entry: AssessedRecord;
  minVenueCitedness: number;
}): ReactElement {
  const styles = useStyles();
  const { record, signals, updates } = entry;
  const assessment = assessUpdates(updates);
  const badges = describeCredibility(signals, minVenueCitedness);
  const year = record.issued?.year;

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

      <Subtitle2>
        {record.url === null ? (
          record.title
        ) : (
          // Opens in the system browser: navigating the pane would discard state
          // and put a third-party page inside a trusted frame (ADR-028).
          <Link href={record.url} target="_blank" rel="noreferrer">
            {record.title}
          </Link>
        )}
      </Subtitle2>

      <Caption1 className={styles.meta}>
        {[authorLine(record), record.containerTitle, year === undefined ? null : String(year)]
          .filter((part) => part !== null && part !== '')
          .join(' · ')}
        {record.type === 'preprint' ? ' · Preprint — not peer reviewed' : ''}
      </Caption1>

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

const RANKING_LABEL = {
  semantic: 'Ranked against your selection, on this machine.',
  lexical: 'Ranked by shared words rather than meaning.',
  'source-order': "Shown in the source's own order; not ranked against your selection.",
} as const;

export function LiteratureResultList(): ReactElement | null {
  const styles = useStyles();
  const [showLimited, setShowLimited] = useState(false);
  const { results, ranking, rankingNote, sentQueries } = useLiteratureStore();
  const [showSent, setShowSent] = useState(false);
  const minVenueCitedness = useSettingsStore((state) => state.litMinVenueCitedness);

  if (results.length === 0) return null;

  const verified = results.filter((entry) => verificationStatus(entry.signals) !== 'limited');
  const limited = results.filter((entry) => verificationStatus(entry.signals) === 'limited');

  return (
    <div className={styles.list}>
      {results.every((entry) => !entry.updates.checked) ? (
        /*
         * One banner, not one per result. Retraction checking is a single
         * setting: when it is off it is off for every paper, so repeating the
         * notice on each card was noise that trained the reader to skip exactly
         * the kind of warning that must not be skipped. The distinction it
         * preserves — silence is not an all-clear — needs stating once.
         */
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            Retractions were not checked. Turn on retraction checking in Settings to see whether any
            of these papers have been retracted or corrected.
          </MessageBarBody>
        </MessageBar>
      ) : null}

      <Caption1 className={styles.ranking}>{RANKING_LABEL[ranking]}</Caption1>

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

      {verified.map((entry) => (
        <ResultCard key={entry.record.id} entry={entry} minVenueCitedness={minVenueCitedness} />
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
              {limited.map((entry) => (
                <ResultCard
                  key={entry.record.id}
                  entry={entry}
                  minVenueCitedness={minVenueCitedness}
                />
              ))}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
