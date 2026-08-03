/**
 * The main pane view (ARCHITECTURE.md §10): connection banner, prompt input
 * with context chip, machine-driven controls, the streaming response region,
 * and the result actions bar. Phase 7: Generate/Stop/Retry and Esc all drive
 * useGeneration (§11.1) — the hook owns the AbortController; the store's
 * `cancel` is only its terminal-state bookkeeping, never called from here.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import { useAppToasts } from '../../components/toaster';
import {
  ConnectionBanner,
  GenerationControls,
  ResponseView,
  useGeneration,
  useStreamStore,
} from '../../features/ai';
import { useHistoryStore } from '../../features/history';
import { ContextSourcePicker, ResultActionsBar, useDocumentActions } from '../../features/document';
import { useSelectedPrompt } from '../../features/prompts';
import { useSettingsStore } from '../../features/settings';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import type { HostInfo } from '../../services/office';
import type { ContextSource, PromptContextVar } from '../../types/domain';
import { usePaneLayout } from '../../hooks/usePaneLayout';
import { formatRelativeTime } from '../../utils/time';
import { useUiStore } from '../ui.store';

const ALL_SOURCES: readonly ContextSource[] = ['none', 'selection', 'paragraph', 'document'];

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    height: '100%',
    minHeight: 0, // load-bearing: lets ResponseView own the scroll region
  },
  /**
   * Short pane: the view itself scrolls and every region takes its natural
   * height, instead of a dozen fixed rows squeezing the result to nothing
   * (ADR-027). The controls stay pinned so Generate is always reachable.
   */
  rootCompact: {
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
  },
  responseCompact: {
    flexGrow: 0,
    minHeight: '8rem',
  },
  stickyControls: {
    position: 'sticky',
    bottom: 0,
    zIndex: 1,
    paddingTop: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  inputArea: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  chipRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap' },
  clearRow: { display: 'flex', justifyContent: 'flex-end' },
  response: { flexGrow: 1, minHeight: 0 },
});

export interface ChatViewProps {
  hostInfo: HostInfo;
}

export function ChatView({ hostInfo }: ChatViewProps): ReactElement {
  const styles = useStyles();
  const toasts = useAppToasts();

  const draft = useUiStore((state) => state.draft);
  const setDraft = useUiStore((state) => state.setDraft);
  const contextSource = useUiStore((state) => state.contextSource);
  const setContextSource = useUiStore((state) => state.setContextSource);
  const setView = useUiStore((state) => state.setView);

  const model = useSettingsStore((state) => state.defaultModel);
  const selectedPrompt = useSelectedPrompt();

  const streamText = useStreamStore((state) => state.text);
  const generation = useGeneration();

  const records = useHistoryStore((state) => state.records);
  const activeRecordId = useHistoryStore((state) => state.activeRecordId);
  const activeRecord = records.find((record) => record.id === activeRecordId) ?? null;
  const streamStatus = useStreamStore((state) => state.status);
  const { compact } = usePaneLayout();

  /**
   * True when the pane is showing a result loaded from history rather than one
   * just produced. Worth saying out loud: otherwise a restored result is
   * indistinguishable from a live one, and "generate" appears to have done
   * nothing.
   */
  const viewingPast =
    activeRecord !== null && streamStatus !== 'connecting' && streamStatus !== 'streaming'
      ? streamText === activeRecord.response && streamText !== ''
      : false;

  /** Clears the pane back to a blank prompt without touching saved history. */
  const startNewPrompt = (): void => {
    useStreamStore.getState().reset();
    useHistoryStore.getState().setActiveRecord(null);
    setDraft('');
  };

  const actions = useDocumentActions();

  const contextOptions = useMemo<readonly ContextSource[]>(() => {
    if (selectedPrompt === null) return ALL_SOURCES;
    const fromTemplate = selectedPrompt.requires.filter(
      (variable): variable is Exclude<PromptContextVar, 'input'> => variable !== 'input',
    );
    return fromTemplate.length === 0 ? ['none'] : fromTemplate;
  }, [selectedPrompt]);

  // Keep the chip legal when the selected template narrows the options.
  useEffect(() => {
    if (!contextOptions.includes(contextSource)) {
      setContextSource(contextOptions[0] ?? 'none');
    }
  }, [contextOptions, contextSource, setContextSource]);

  /*
   * Opening a saved result restores the prompt that produced it.
   *
   * Without this, opening a record showed its response while the textarea kept
   * whatever was last typed — so every entry in history appeared to have the
   * same prompt, and the record looked like a response with no question. The
   * prompt is half of what a record *is*.
   *
   * Keyed on the record id rather than the record, so re-renders do not
   * overwrite edits: once a record is open, the draft is the user's again and
   * they may reword it before regenerating.
   */
  const loadedRecordId = useRef<string | null>(null);
  useEffect(() => {
    if (activeRecordId === null) {
      loadedRecordId.current = null;
      return;
    }
    if (loadedRecordId.current === activeRecordId) return;
    loadedRecordId.current = activeRecordId;
    if (activeRecord !== null) setDraft(activeRecord.prompt);
  }, [activeRecordId, activeRecord, setDraft]);

  const needsInput = selectedPrompt === null || selectedPrompt.requires.includes('input');
  const active = generation.isActive;
  const generateDisabledReason =
    model === null
      ? 'Pick a model first'
      : needsInput && draft.trim() === ''
        ? 'Write a prompt first'
        : undefined;

  const handleGenerate = (): void => {
    if (active) return;
    if (generateDisabledReason !== undefined || model === null) {
      if (generateDisabledReason !== undefined) toasts.info(generateDisabledReason);
      return;
    }
    void generation.generate({ template: selectedPrompt, draft, contextSource, model });
  };

  /**
   * "Refine" is a NEW single-shot run seeded with the previous output, not an
   * appended chat turn (ADR-021): it produces its own record with its own
   * sources, so provenance never blurs across runs.
   */
  const handleRefine = (): void => {
    if (active || model === null || streamText === '') return;
    if (draft.trim() === '') {
      toasts.info('Say how to change it — for example “make it shorter”.');
      return;
    }
    void generation.generate({
      template: selectedPrompt,
      draft,
      contextSource,
      model,
      priorResult: streamText,
    });
  };

  useKeyboardShortcuts({
    onGenerate: handleGenerate,
    onStop: generation.stop,
    ...(streamText === ''
      ? {}
      : {
          onCopy: () => {
            void actions.copy(streamText);
          },
          onInsert: () => {
            void actions.insertAtCursor(streamText);
          },
        }),
  });

  return (
    <div className={mergeClasses(styles.root, compact && styles.rootCompact)}>
      <ConnectionBanner
        platform={hostInfo.platform}
        onOpenSettings={() => {
          setView('settings');
        }}
      />
      {viewingPast ? (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            Showing a saved result from {formatRelativeTime(activeRecord?.createdAt ?? '')}.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      <div className={styles.inputArea}>
        <Textarea
          aria-label="Prompt"
          placeholder="Ask anything, or pick a prompt template…"
          value={draft}
          rows={compact ? 2 : 3}
          resize="vertical"
          onChange={(_, data) => {
            setDraft(data.value);
          }}
        />
        <div className={styles.chipRow}>
          <ContextSourcePicker
            value={contextSource}
            options={contextOptions}
            onChange={setContextSource}
          />
        </div>
      </div>
      <div className={compact ? styles.stickyControls : undefined}>
        <GenerationControls
          onGenerate={handleGenerate}
          onStop={generation.stop}
          generateDisabledReason={generateDisabledReason}
        />
      </div>
      {!viewingPast && (streamText !== '' || draft !== '') && !active ? (
        <div className={styles.clearRow}>
          <Button size="small" appearance="subtle" icon={<AddRegular />} onClick={startNewPrompt}>
            New prompt
          </Button>
        </div>
      ) : null}
      <div className={mergeClasses(styles.response, compact && styles.responseCompact)}>
        <ResponseView onRetry={generation.retry} compact={compact} />
      </div>
      <ResultActionsBar
        text={streamText}
        record={activeRecord}
        onRefine={handleRefine}
        refineDisabled={active}
        compact={compact}
      />
    </div>
  );
}
