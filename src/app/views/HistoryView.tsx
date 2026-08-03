/**
 * Generation history view (ADR-021): a flat list of past runs. Opening one
 * shows that result again in the chat view — there is nothing to "continue",
 * because each run was a single-shot exchange.
 */
import type { ReactElement } from 'react';
import { Button, Subtitle2, Text, makeStyles, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { EmptyState } from '../../components/EmptyState';
import { useStreamStore } from '../../features/ai';
import { HistoryList, useHistoryStore } from '../../features/history';
import { useUiStore } from '../ui.store';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    height: '100%',
    minHeight: 0,
  },
  headerRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flexGrow: 1 },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: 'auto' },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function HistoryView(): ReactElement {
  const styles = useStyles();
  const setView = useUiStore((state) => state.setView);
  const records = useHistoryStore((state) => state.records);
  const setActiveRecord = useHistoryStore((state) => state.setActiveRecord);
  const clearRecords = useHistoryStore((state) => state.clearRecords);

  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <Subtitle2>History</Subtitle2>
        <div className={styles.spacer} />
        {records.length === 0 ? null : (
          <Button appearance="subtle" size="small" icon={<DeleteRegular />} onClick={clearRecords}>
            Clear all
          </Button>
        )}
      </div>
      {records.length === 0 ? null : (
        <Text size={200} className={styles.muted}>
          Every generation is saved here — prompt, response, and the sources it used.
        </Text>
      )}
      <div className={styles.scroll}>
        {records.length === 0 ? (
          <EmptyState
            icon="🗂️"
            title="No generations yet"
            body="Each result you generate is saved here automatically, with the excerpts it drew on."
          />
        ) : (
          <HistoryList
            onOpen={(id) => {
              // The response pane renders from the stream store, so opening a
              // record has to load it there — otherwise the pane would keep
              // showing the last live generation instead of what was clicked.
              const record = records.find((candidate) => candidate.id === id);
              if (record === undefined) return;
              setActiveRecord(id);
              useStreamStore.getState().restore(record);
              setView('chat');
            }}
          />
        )}
      </div>
    </div>
  );
}
