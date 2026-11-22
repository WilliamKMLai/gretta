/**
 * Generation history list (ARCHITECTURE.md §10; ADR-021).
 *
 * Each row is one complete run — prompt, response, model, sources — not a turn
 * in a thread. Opening one shows that result again; there is nothing to
 * "continue", which is exactly the point: the engine is single-shot, so the UI
 * stops implying otherwise.
 */
import type { ReactElement } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  CodeRegular,
  DeleteRegular,
  DocumentRegular,
  MoreHorizontalRegular,
} from '@fluentui/react-icons';
import { useAppToasts } from '../../../components/toaster';
import type { AppliedAction, GenerationRecord } from '../../../types/domain';
import { downloadTextFile } from '../../../utils/download';
import { formatRelativeTime } from '../../../utils/time';
import { exportFilename, recordToJson, recordToMarkdown } from '../export';
import { describeRecord, useHistoryStore } from '../history.store';
import { isTruncated } from '../contextExcerpt';

const APPLIED_LABELS: Record<AppliedAction['kind'], string> = {
  insert: 'inserted',
  replace: 'replaced',
  append: 'appended',
  comment: 'commented',
};

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  active: { border: `1px solid ${tokens.colorBrandStroke1}` },
  open: {
    flexGrow: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: tokens.spacingVerticalXXS,
    textAlign: 'left',
  },
  title: { overflowWrap: 'anywhere' },
  // Two lines at most: enough to recognise the passage, not enough to turn the
  // list into a wall of text on a 320px pane.
  excerpt: {
    color: tokens.colorNeutralForeground3,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    fontStyle: 'italic',
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
  },
});

export interface HistoryListProps {
  /** Opens a record in the chat view. */
  onOpen: (id: string) => void;
}

export function HistoryList({ onOpen }: HistoryListProps): ReactElement {
  const styles = useStyles();
  const toasts = useAppToasts();
  const records = useHistoryStore((state) => state.records);
  const activeRecordId = useHistoryStore((state) => state.activeRecordId);
  const deleteRecord = useHistoryStore((state) => state.deleteRecord);

  const exportRecord = (record: GenerationRecord, extension: 'md' | 'json'): void => {
    const text = extension === 'md' ? recordToMarkdown(record) : recordToJson(record);
    const mime = extension === 'md' ? 'text/markdown' : 'application/json';
    try {
      downloadTextFile(exportFilename(record, extension), text, mime);
    } catch {
      toasts.error('Download was blocked — open the result and copy it instead.');
    }
  };

  return (
    <div className={styles.list}>
      {records.map((record) => (
        <div
          key={record.id}
          className={mergeClasses(styles.item, record.id === activeRecordId && styles.active)}
        >
          <Button
            appearance="subtle"
            className={styles.open}
            onClick={() => {
              onOpen(record.id);
            }}
          >
            <Text className={styles.title}>{describeRecord(record)}</Text>
            {record.contextExcerpt === undefined ? null : (
              /*
               * The passage the run drew on. Without it a row shows sources
               * with nothing to check them against, which asserts provenance
               * it cannot support. Truncation is stated rather than implied —
               * a silently clipped excerpt would be its own small dishonesty.
               */
              <Caption1 className={styles.excerpt}>
                “{record.contextExcerpt.text}
                {isTruncated(record.contextExcerpt) ? '…' : ''}”
                {isTruncated(record.contextExcerpt)
                  ? ` (opening of ${record.contextExcerpt.totalChars.toLocaleString()} characters)`
                  : ''}
              </Caption1>
            )}
            <span className={styles.meta}>
              <Caption1>{formatRelativeTime(record.createdAt)}</Caption1>
              <Caption1>· {record.model}</Caption1>
              {record.templateName === undefined ? null : (
                <Caption1>· {record.templateName}</Caption1>
              )}
              {record.contextSource === undefined ? null : (
                <Caption1>· from {record.contextSource}</Caption1>
              )}
              {record.sources === undefined || record.sources.length === 0 ? null : (
                <Badge appearance="tint" size="small">
                  {record.sources.length} source{record.sources.length === 1 ? '' : 's'}
                </Badge>
              )}
              {record.outcome === 'completed' ? null : (
                <Badge appearance="tint" color="warning" size="small">
                  {record.outcome}
                </Badge>
              )}
              {record.applied === undefined ? null : (
                <Badge appearance="tint" color="success" size="small">
                  {APPLIED_LABELS[record.applied.kind]}
                </Badge>
              )}
            </span>
          </Button>

          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                appearance="subtle"
                icon={<MoreHorizontalRegular />}
                aria-label={`Actions for ${describeRecord(record)}`}
              />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem
                  icon={<DocumentRegular />}
                  onClick={() => {
                    exportRecord(record, 'md');
                  }}
                >
                  Export Markdown
                </MenuItem>
                <MenuItem
                  icon={<CodeRegular />}
                  onClick={() => {
                    exportRecord(record, 'json');
                  }}
                >
                  Export JSON
                </MenuItem>
                <MenuItem
                  icon={<DeleteRegular />}
                  onClick={() => {
                    deleteRecord(record.id);
                  }}
                >
                  Delete
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      ))}
    </div>
  );
}
