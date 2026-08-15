/**
 * The main pane view (ARCHITECTURE.md §10): connection banner, prompt input
 * with context chip, machine-driven controls, the streaming response region,
 * and the result actions bar. Phase 7: Generate/Stop/Retry and Esc all drive
 * useGeneration (§11.1) — the hook owns the AbortController; the store's
 * `cancel` is only its terminal-state bookkeeping, never called from here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
  AttachmentStrip,
  ConnectionBanner,
  DocumentFigureButton,
  GenerationControls,
  ImageAttachButton,
  ResponseView,
  useAttachmentsStore,
  useGeneration,
  useImageAttach,
  useStreamStore,
  useVisionModel,
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
  /** Drop feedback: the prompt box itself is the target, so it says so. */
  dropTarget: {
    outline: `2px dashed ${tokens.colorBrandStroke1}`,
    outlineOffset: '2px',
    borderRadius: tokens.borderRadiusMedium,
  },
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
  const { attachFromTransfer, attachSelectionFigures } = useImageAttach();
  const [dragging, setDragging] = useState(false);

  /*
   * Resolving images here, not in useGeneration (ADR-034).
   *
   * This view already decides which model a run uses; images are the same kind
   * of decision, and it is also where the attachment strip and its capability
   * warning are rendered. Deciding in one place means the pane cannot promise
   * to send a picture that the request then drops.
   */
  const vision = useVisionModel();

  /**
   * Reads the staged images at call time rather than render time.
   *
   * The automatic path (ADR-035 amendment) stages a figure moments before the
   * request is built, so a value captured during render would miss it — the
   * store subscription has not re-rendered yet.
   */
  const resolveRunOptions = (): {
    model: string;
    images?: string[];
    visionModel: string | null;
  } | null => {
    // A run with no attachments can still carry figures the knowledge base
    // retrieves (ADR-036), so the vision model is resolved either way — but the
    // run is only *routed* to it when there is actually something to look at.
    const canSee = vision.supportsVision && vision.model !== null;
    const staged = useAttachmentsStore.getState().images;
    const sendAttached = staged.length > 0 && vision.reason === null;
    if (!canSee && !sendAttached) return null;
    return {
      model: sendAttached ? (vision.model ?? model ?? '') : (model ?? ''),
      ...(sendAttached ? { images: staged.map((image) => image.dataBase64) } : {}),
      visionModel: canSee ? vision.model : null,
    };
  };

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

  /**
   * "Selection" means the whole selection, figures included (ADR-035
   * amendment).
   *
   * Picking that chip is the user saying what they are pointing at; requiring
   * a second, separate click to include a figure inside it made the tool
   * pedantic about a distinction only it could see. Runs only for this chip —
   * paragraph and whole-document contexts would drag in figures nobody asked
   * about, and "none" means none.
   */
  const stageSelectionFigures = async (): Promise<void> => {
    if (contextSource !== 'selection') return;
    await attachSelectionFigures();
  };

  const handleGenerate = async (): Promise<void> => {
    if (active) return;
    if (generateDisabledReason !== undefined || model === null) {
      if (generateDisabledReason !== undefined) toasts.info(generateDisabledReason);
      return;
    }
    await stageSelectionFigures();
    await generation.generate({
      template: selectedPrompt,
      draft,
      contextSource,
      model,
      ...resolveRunOptions(),
    });
  };

  /**
   * "Refine" is a NEW single-shot run seeded with the previous output, not an
   * appended chat turn (ADR-021): it produces its own record with its own
   * sources, so provenance never blurs across runs.
   */
  const handleRefine = async (): Promise<void> => {
    if (active || model === null || streamText === '') return;
    if (draft.trim() === '') {
      toasts.info('Say how to change it — for example “make it shorter”.');
      return;
    }
    await stageSelectionFigures();
    await generation.generate({
      template: selectedPrompt,
      draft,
      contextSource,
      model,
      priorResult: streamText,
      ...resolveRunOptions(),
    });
  };

  // The handlers are async now (they may read a figure out of the selection
  // first); these call sites all expect a plain void callback.
  const startGenerate = (): void => {
    void handleGenerate();
  };
  const startRefine = (): void => {
    void handleRefine();
  };

  useKeyboardShortcuts({
    onGenerate: startGenerate,
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
          className={dragging ? styles.dropTarget : undefined}
          aria-label="Prompt"
          placeholder="Ask anything, or pick a prompt template…"
          value={draft}
          rows={compact ? 2 : 3}
          resize="vertical"
          onChange={(_, data) => {
            setDraft(data.value);
          }}
          /*
           * Paste and drop are handled here rather than on the whole pane so
           * they cannot swallow a paste meant for another field. Both defer to
           * the default when the payload holds no image: pasting text into the
           * prompt box must keep working, and `preventDefault` runs only once
           * an image has actually been found.
           */
          onPaste={(event) => {
            const { clipboardData } = event;
            if (Array.from(clipboardData.files).every((file) => !file.type.startsWith('image/'))) {
              return;
            }
            event.preventDefault();
            void attachFromTransfer(clipboardData);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setDragging(false);
            void attachFromTransfer(event.dataTransfer);
          }}
        />
        <AttachmentStrip />
        <div className={styles.chipRow}>
          <ContextSourcePicker
            value={contextSource}
            options={contextOptions}
            onChange={setContextSource}
          />
          <ImageAttachButton disabled={active} />
          <DocumentFigureButton available={hostInfo.available} disabled={active} />
        </div>
      </div>
      <div className={compact ? styles.stickyControls : undefined}>
        <GenerationControls
          onGenerate={startGenerate}
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
        onRefine={startRefine}
        refineDisabled={active}
        compact={compact}
      />
    </div>
  );
}
