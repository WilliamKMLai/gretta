/**
 * Streaming response area (ARCHITECTURE.md §10). Pre-wrapped plain text with
 * auto-scroll that yields to the user: while they're pinned to the bottom new
 * tokens keep the view pinned; once they scroll up we stop yanking until they
 * return. Screen readers get a debounced polite live region (a snapshot every
 * ~2 s while streaming + a final announcement) — never per-token chatter.
 *
 * When the knowledge base contributed context (ADR-020), the excerpts that were
 * actually sent are listed underneath as Sources, with file + page/paragraph,
 * so every retrieved claim can be traced back to a document on disk.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { describeBudget } from '../context/budget';
import { MarkdownView } from './MarkdownView';
import { useStreamStore } from '../stream.store';

const ANNOUNCE_INTERVAL_MS = 2_000;
const STICK_THRESHOLD_PX = 32;

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0, // load-bearing: lets this flex child shrink so the scroll region engages
    height: '100%',
    gap: tokens.spacingVerticalS,
  },
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  /**
   * Compact pane: the parent scrolls, so this must size to its content and be
   * unable to shrink. Turning off the scroll while leaving `height: 100%` on
   * the root made the text paint outside a still-constrained box and land on
   * top of the Sources list below it (ADR-027).
   */
  rootCompact: {
    height: 'auto',
    flexShrink: 0,
  },
  notice: { flexShrink: 0 },
  scrollCompact: {
    flexGrow: 0,
    flexShrink: 0,
    overflowY: 'visible',
  },
  text: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    userSelect: 'text',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
  sources: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    paddingTop: tokens.spacingVerticalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sourceItem: {
    color: tokens.colorNeutralForeground3,
    overflowWrap: 'anywhere',
  },
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
});

export interface ResponseViewProps {
  /** Short pane: the parent owns scrolling, so this must not nest its own. */
  compact?: boolean;
  /** Wired to useGeneration.retry — shown on stream interruption (§11.1). */
  onRetry?: (() => void) | undefined;
}

export function ResponseView({ onRetry, compact = false }: ResponseViewProps = {}): ReactElement {
  const styles = useStyles();
  const status = useStreamStore((state) => state.status);
  const text = useStreamStore((state) => state.text);
  const stats = useStreamStore((state) => state.stats);
  const error = useStreamStore((state) => state.error);
  const sources = useStreamStore((state) => state.sources);
  const budget = useStreamStore((state) => state.budget);
  const budgetNote = budget === null ? null : describeBudget(budget);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (status === 'streaming') {
      const id = window.setInterval(() => {
        setAnnouncement(`Generating — ${String(textRef.current.length)} characters so far.`);
      }, ANNOUNCE_INTERVAL_MS);
      return () => {
        window.clearInterval(id);
      };
    }
    if (status === 'completed') {
      setAnnouncement(
        stats === null
          ? 'Response complete.'
          : `Response complete — ${String(stats.evalCount)} tokens.`,
      );
    } else if (status === 'cancelled') {
      setAnnouncement('Generation stopped — partial result kept.');
    } else if (status === 'error') {
      setAnnouncement('Generation failed.');
    } else {
      setAnnouncement('');
    }
    return undefined;
  }, [status, stats]);

  if (status === 'idle') {
    return (
      <div className={styles.root}>
        <EmptyState
          icon="✍️"
          title="Ready when you are"
          body="Pick a model, write a prompt, and press ⌘/Ctrl+Enter."
        />
      </div>
    );
  }

  return (
    <div className={mergeClasses(styles.root, compact && styles.rootCompact)}>
      {status === 'connecting' ? (
        <div className={styles.statusRow}>
          <Spinner size="extra-tiny" />
          <Text size={200}>Contacting model…</Text>
        </div>
      ) : status === 'streaming' ? (
        <div className={styles.statusRow}>
          <Spinner size="extra-tiny" />
          <Text size={200}>Generating…</Text>
        </div>
      ) : status === 'cancelled' ? (
        <Text size={200} className={styles.statusRow}>
          Stopped — partial result kept.
        </Text>
      ) : status === 'completed' && stats !== null ? (
        <Text size={200} className={styles.statusRow}>
          {stats.evalCount} tokens · {stats.tokensPerSecond} tok/s ·{' '}
          {(stats.totalDurationMs / 1000).toFixed(1)} s
        </Text>
      ) : null}
      {status === 'error' ? (
        <>
          <ErrorBanner error={error} title="Generation failed" />
          {onRetry === undefined ? null : (
            <div>
              <Button size="small" icon={<ArrowClockwiseRegular />} onClick={onRetry}>
                Retry
              </Button>
            </div>
          )}
        </>
      ) : null}
      <div
        ref={scrollRef}
        className={mergeClasses(styles.scroll, compact && styles.scrollCompact)}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
        }}
      >
        {/* While tokens are still arriving the text is mid-syntax, so render
            it raw and format once the run has settled (ADR-026). */}
        {status === 'completed' || status === 'cancelled' ? (
          <MarkdownView text={text} />
        ) : (
          <div className={styles.text}>{text}</div>
        )}
      </div>
      {budgetNote === null ? null : (
        /*
         * Pinned and multiline. The note names every dropped source, so it runs
         * to several lines; left shrinkable in a column that has run out of
         * room, it clipped its own height and painted over the Sources list
         * beneath — the same defect `rootCompact` above was written to fix,
         * reappearing on a sibling nobody had pinned.
         */
        <MessageBar className={styles.notice} intent="warning" layout="multiline">
          <MessageBarBody>{budgetNote}</MessageBarBody>
        </MessageBar>
      )}
      {budget === null || budgetNote !== null || budget.usagePct < 70 ? null : (
        <Text size={200} className={styles.sourceItem}>
          Context used: about {budget.usagePct}% of the available window.
        </Text>
      )}
      {sources.length === 0 ? null : (
        <div className={styles.sources}>
          <Text size={200} weight="semibold">
            Sources
          </Text>
          {sources.map((chunk, index) => (
            <Text
              key={`${chunk.collectionId}:${chunk.source}:${String(index)}`}
              size={200}
              className={styles.sourceItem}
            >
              [{index + 1}] {chunk.source}
              {chunk.locator.page !== null
                ? `, p. ${String(chunk.locator.page)}`
                : chunk.locator.paragraph !== null
                  ? `, \u00b6${String(chunk.locator.paragraph)}`
                  : ''}
            </Text>
          ))}
        </div>
      )}
      <div aria-live="polite" role="status" className={styles.visuallyHidden}>
        {announcement}
      </div>
    </div>
  );
}
