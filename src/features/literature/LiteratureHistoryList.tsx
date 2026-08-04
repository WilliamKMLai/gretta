/**
 * Recent literature searches (DECISIONS.md ADR-028).
 *
 * Reads the same on-device cache `useLiteratureSearch` writes to
 * (`cache.ts`) — ADR-028 already called that cache a record of "search
 * history"; this makes that history visible instead of only working
 * invisibly behind the scenes.
 *
 * Clicking an entry restores its query text and year filter, then reuses the
 * cached search via `reuseSearch` — instant if the current passage still
 * matches, a real re-rank if it doesn't, but never a fresh network fetch,
 * unlike the Search button. This does not bypass ADR-028's review gate — it
 * is an application of it in a new spot, not an exception to it: the row
 * already shows the exact query text that would be sent, in full, before the
 * click, which is the same information the draft field shows before a press
 * of Search. The query has also already been sent once before, reviewed in
 * the same way. What the gate forbids is a query reaching the network before
 * the user has seen it; a visible row is not that.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Body1,
  Button,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { formatRelativeTime } from '../../utils/time';
import { listEntries } from './cache';
import type { CacheEntry } from './cache';
import { useLiteratureStore } from './literature.store';
import { useLiteratureSearch } from './useLiteratureSearch';

/** Display labels for the internal source keys stored on a cache entry. */
const SOURCE_LABELS: Record<string, string> = {
  pubmed: 'PubMed',
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
  openalex: 'OpenAlex',
};

const useStyles = makeStyles({
  // Pinned like every other direct child of the panel's scrolling column
  // (see LiteraturePanel.tsx) — an unpinned child in a flex column that has
  // run out of room gets compressed instead of letting the panel scroll.
  root: { flexShrink: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  item: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    textAlign: 'left',
    width: '100%',
    maxWidth: '100%',
  },
  query: { overflowWrap: 'anywhere' },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
  },
});

function describeSources(sources: readonly string[]): string {
  if (sources.length === 0) return 'no sources';
  return sources.map((source) => SOURCE_LABELS[source] ?? source).join(', ');
}

export function LiteratureHistoryList(): ReactElement | null {
  const styles = useStyles();
  // Refetches on mount and whenever a search finishes, so a search that just
  // wrote to the cache shows up here without navigating away and back.
  const phase = useLiteratureStore((state) => state.phase);
  const { reuseSearch, busy } = useLiteratureSearch();
  const [entries, setEntries] = useState<CacheEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listEntries().then((loaded) => {
      if (!cancelled) setEntries(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  if (entries.length === 0) return null;

  return (
    // Open by default, unlike "Advanced search parameters": this only renders
    // once there is something to show, so the extra click to see it would be
    // pure friction rather than decluttering.
    <Accordion className={styles.root} collapsible defaultOpenItems="recent-searches">
      <AccordionItem value="recent-searches">
        <AccordionHeader size="small">Recent searches ({entries.length})</AccordionHeader>
        <AccordionPanel>
          <div className={styles.list}>
            {entries.map((entry) => (
              <Button
                key={entry.key}
                appearance="subtle"
                className={styles.item}
                disabled={busy}
                onClick={() => {
                  void reuseSearch(entry);
                }}
              >
                <Body1 className={styles.query}>{entry.query}</Body1>
                <span className={styles.meta}>
                  <Caption1>{formatRelativeTime(entry.storedAt)}</Caption1>
                  <Caption1>· {describeSources(entry.sources)}</Caption1>
                  <Caption1>
                    · {entry.results.length} result{entry.results.length === 1 ? '' : 's'}
                  </Caption1>
                  {entry.fromYear === null ? null : <Caption1>· since {entry.fromYear}</Caption1>}
                </span>
              </Button>
            ))}
          </div>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
