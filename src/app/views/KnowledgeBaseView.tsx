/**
 * Knowledge-base view (ADR-020) — hosts the collection manager and the
 * per-document binding controls. Scroll ownership matches the other views.
 */
import type { ReactElement } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { KnowledgeBasePanel } from '../../features/knowledgebase';

const useStyles = makeStyles({
  root: {
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    padding: tokens.spacingHorizontalM,
  },
});

export function KnowledgeBaseView(): ReactElement {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <KnowledgeBasePanel />
    </div>
  );
}
