/**
 * Result actions (ARCHITECTURE.md §10): Copy · Replace · Insert · Comment
 * (runtime-gated on WordApi 1.4) · Export ▾ (Markdown/JSON). Everything is
 * disabled until there's a result; partial text from cancelled/error runs
 * counts (§9 — partial output stays usable).
 */
import type { ReactElement } from 'react';
import {
  Button,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownloadRegular,
  ArrowSyncRegular,
  ClipboardTextEditRegular,
  CommentAddRegular,
  CopyRegular,
  InsertRegular,
  MoreHorizontalRegular,
} from '@fluentui/react-icons';
import type { GenerationRecord } from '../../../types/domain';
import { downloadTextFile } from '../../../utils/download';
import { markdownToPlainText } from '../../../utils/markdown';
import { exportFilename, recordToJson, recordToMarkdown, useHistoryStore } from '../../history';
import { useDocumentActions } from '../useDocumentActions';

const useStyles = makeStyles({
  root: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
});

export interface ResultActionsBarProps {
  /** The current result (partial or complete); empty disables everything. */
  text: string;
  /** Record backing the shown result; null when there is nothing to export. */
  record: GenerationRecord | null;
  /** Starts a new run seeded with this result (ADR-021). */
  onRefine: () => void;
  refineDisabled: boolean;
  /** Short pane: collapse the secondary actions into a menu (ADR-027). */
  compact?: boolean;
}

export function ResultActionsBar({
  text,
  record,
  onRefine,
  refineDisabled,
  compact = false,
}: ResultActionsBarProps): ReactElement {
  const styles = useStyles();
  const actions = useDocumentActions();
  const disabled = text === '';
  const date = new Date().toISOString().slice(0, 10);

  const exportMarkdown = (): void => {
    if (record === null) {
      downloadTextFile(`gretta-result-${date}.md`, `${text}\n`, 'text/markdown');
      return;
    }
    downloadTextFile(exportFilename(record, 'md'), recordToMarkdown(record), 'text/markdown');
  };

  const exportJson = (): void => {
    if (record === null) {
      downloadTextFile(
        `gretta-result-${date}.json`,
        `${JSON.stringify({ text, exportedAt: new Date().toISOString() }, null, 2)}\n`,
        'application/json',
      );
      return;
    }
    downloadTextFile(exportFilename(record, 'json'), recordToJson(record), 'application/json');
  };

  /**
   * Applying a result to the document is worth remembering: history then shows
   * what actually made it into the file, not just what was generated (ADR-021).
   */
  const applyToDocument = (kind: 'insert' | 'replace' | 'append' | 'comment'): void => {
    // Word receives plain text (§13.1), so Markdown syntax is resolved to
    // readable prose first — otherwise a manuscript gets literal `**bold**`
    // and `## Heading` (ADR-026).
    const forDocument = markdownToPlainText(text);
    const run =
      kind === 'replace'
        ? actions.replaceSelection(forDocument)
        : kind === 'comment'
          ? actions.comment(forDocument)
          : actions.insertAtCursor(forDocument);
    void run.then(
      () => {
        if (record !== null) useHistoryStore.getState().markApplied(record.id, kind);
      },
      () => {
        /* the action layer already surfaces its own failure toast */
      },
    );
  };

  /**
   * Short pane: six buttons wrap onto two rows and cost ~90 px of vertical
   * space that the result needs more (ADR-027). Copy and Insert stay inline —
   * they are the ones people reach for — and the rest move into a menu.
   */
  if (compact) {
    return (
      <div className={styles.root} role="toolbar" aria-label="Result actions">
        <Button
          size="small"
          icon={<CopyRegular />}
          disabled={disabled}
          onClick={() => {
            void actions.copy(text);
          }}
        >
          Copy
        </Button>
        <Button
          size="small"
          icon={<InsertRegular />}
          disabled={disabled}
          onClick={() => {
            applyToDocument('insert');
          }}
        >
          Insert
        </Button>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <MenuButton size="small" icon={<MoreHorizontalRegular />} disabled={disabled}>
              More
            </MenuButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem
                icon={<ClipboardTextEditRegular />}
                onClick={() => {
                  applyToDocument('replace');
                }}
              >
                Replace selection
              </MenuItem>
              <MenuItem icon={<ArrowSyncRegular />} disabled={refineDisabled} onClick={onRefine}>
                Refine
              </MenuItem>
              {actions.commentsSupported ? (
                <MenuItem
                  icon={<CommentAddRegular />}
                  onClick={() => {
                    applyToDocument('comment');
                  }}
                >
                  Comment
                </MenuItem>
              ) : null}
              <MenuItem icon={<ArrowDownloadRegular />} onClick={exportMarkdown}>
                Export Markdown (.md)
              </MenuItem>
              <MenuItem icon={<ArrowDownloadRegular />} onClick={exportJson}>
                Export JSON (.json)
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
    );
  }

  return (
    <div className={styles.root} role="toolbar" aria-label="Result actions">
      <Button
        size="small"
        icon={<CopyRegular />}
        disabled={disabled}
        onClick={() => {
          void actions.copy(text);
        }}
      >
        Copy
      </Button>
      <Button
        size="small"
        icon={<ClipboardTextEditRegular />}
        disabled={disabled}
        onClick={() => {
          applyToDocument('replace');
        }}
      >
        Replace
      </Button>
      <Button
        size="small"
        icon={<ArrowSyncRegular />}
        disabled={disabled || refineDisabled}
        title="Write how to change it, then refine — this starts a new generation"
        onClick={onRefine}
      >
        Refine
      </Button>
      <Button
        size="small"
        icon={<InsertRegular />}
        disabled={disabled}
        onClick={() => {
          applyToDocument('insert');
        }}
      >
        Insert
      </Button>
      {actions.commentsSupported ? (
        <Button
          size="small"
          icon={<CommentAddRegular />}
          disabled={disabled}
          onClick={() => {
            applyToDocument('comment');
          }}
        >
          Comment
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <MenuButton size="small" icon={<ArrowDownloadRegular />} disabled={disabled}>
            Export
          </MenuButton>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={exportMarkdown}>Markdown (.md)</MenuItem>
            <MenuItem onClick={exportJson}>JSON (.json)</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}
