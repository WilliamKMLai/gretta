/**
 * The core generation hook (ARCHITECTURE.md §11.1; ADR-007/008/011).
 *
 * One `generate()` call walks the whole flow: capture document context
 * (only the variables the prompt actually needs, BEFORE the machine starts —
 * unmet requirements surface as typed OfficeErrors via toast and never enter
 * the stream store; the rules live in prompts/template.ts) → build the
 * ChatRequest (pure, in ./request.ts: interpolation, settings ⊕ per-template
 * defaults) → drive the §9 machine from the client's event stream, batching
 * token appends through a single rAF per frame → finalize the active
 * conversation on EVERY terminal branch (partial text included, so history
 * never loses content) → run autoCopy/autoInsert on completion.
 *
 * Cancellation (ADR-011): `stop()` aborts the AbortController; the transport
 * ends the generator silently (no event, no error), the loop falls through,
 * and the aborted signal routes to `cancel()` — a normal terminal state. A
 * stream that ends without `done` and without an abort is an interruption.
 *
 * Request scope (M1): each generate is a single exchange — system (when the
 * template has one) plus one user message. The history store records each run;
 * prior runs are never resent (ADR-021).
 *
 * Context providers (ADR-020): between capture and request building, the
 * ContextProvider pipeline contributes extra labeled context — today the local
 * knowledge base, scoped to the collections bound to the open document. The
 * stage is purely additive: providers that are disabled, unbound, slow, or
 * failing contribute nothing and generation proceeds unchanged.
 */
import { useCallback, useMemo } from 'react';
import { useAppToasts } from '../../components/toaster';
import { getServices } from '../../app/services';
import type { GenerationOutcome, GenerationStats, PromptContextVar } from '../../types/domain';
import { OfficeError, StreamError, toAppError } from '../../types/errors';
import { markdownToPlainText } from '../../utils/markdown';
import { toContextExcerpt, useHistoryStore } from '../history';
import {
  applyTemplate,
  assertRequiredContext,
  neededVars,
  requiredVars,
  type PromptVars,
} from '../prompts';
import { useSettingsStore } from '../settings';
import { useKnowledgeBaseStore } from '../knowledgebase';
import { assembleContextText, collectSources, runContextProviders } from './context/provider';
import { allocateBudget, describeBudget } from './context/budget';
import { MAX_RUN_FIGURES, fetchRunFigures } from './context/figures';
import { useCalibrationStore } from './calibration.store';
import { createKnowledgeBaseProvider } from './context/knowledgeBaseProvider';
import { buildChatRequest, type GenerationInput, type RetrievedContext } from './request';
import { useStreamStore } from './stream.store';
import { useAttachmentsStore } from './attachments.store';

export interface UseGenerationResult {
  generate: (input: GenerationInput) => Promise<void>;
  /** Aborts the in-flight request; the machine lands in `cancelled`. */
  stop: () => void;
  /** Re-runs the last `generate()` input (the interruption Retry UX). */
  retry: () => void;
  isActive: boolean;
}

async function captureVars(needed: Set<PromptContextVar>, draft: string): Promise<PromptVars> {
  const office = getServices().office;
  const vars: PromptVars = {};
  if (needed.has('input')) vars.input = draft;
  if (needed.has('selection')) vars.selection = (await office.getSelection()).text;
  if (needed.has('paragraph')) vars.paragraph = await office.getParagraph();
  if (needed.has('document')) vars.document = await office.getDocument();
  return vars;
}

/**
 * Module-scoped lifecycle (same one-store, one-controller rule as
 * `literature/searchRun.ts`): switching views unmounts `ChatView`, so holding
 * these in hook `useRef`s stranded Stop/Esc/Retry and let "New prompt" reset
 * the store while leaving the Ollama stream running in the background.
 */
let activeController: AbortController | null = null;
let streamOwner: AbortController | null = null;
let lastInput: GenerationInput | null = null;

/** Aborts any in-flight generation (context retrieval, figures, or chat stream). */
export function abortActiveGeneration(): void {
  activeController?.abort();
  activeController = null;
}

export function useGeneration(): UseGenerationResult {
  const toasts = useAppToasts();
  const status = useStreamStore((state) => state.status);
  const isActive = status === 'connecting' || status === 'streaming';

  const generate = useCallback(
    async (input: GenerationInput): Promise<void> => {
      const stream = useStreamStore.getState();
      if (stream.status === 'connecting' || stream.status === 'streaming') return;
      lastInput = input;

      // Requirement: a prompt to send (free mode always; templates that use {{input}}).
      const needsInput = requiredVars(input.template, input.contextSource).includes('input');
      if (needsInput && input.draft.trim() === '') {
        toasts.info('Write a prompt first.');
        return;
      }

      // §11.1: capture context BEFORE the machine starts; unmet requirements stop here.
      let vars: PromptVars;
      try {
        vars = await captureVars(neededVars(input.template, input.contextSource), input.draft);
        assertRequiredContext(requiredVars(input.template, input.contextSource), vars);
      } catch (cause) {
        const error = toAppError(
          cause,
          (c) => new OfficeError('office-failed', 'Could not read the document.', { cause: c }),
        );
        toasts.error(error.message);
        return;
      }

      const settings = useSettingsStore.getState();

      /*
       * Images ride in on the input, already resolved (ADR-034).
       *
       * The caller decides whether to attach them and which model can read
       * them, for the same reason it already decides `model`: it is the view
       * that shows the attachments and the capability warning, so a run whose
       * images were dropped and a pane that says so cannot disagree. By the
       * time it reaches here, `input.model` IS the model that will answer —
       * history, calibration, and the budget all follow from that one fact.
       */
      const attachedImages = input.images?.length ?? 0;

      // §16 pipeline: gather optional extra context (RAG) before building the
      // request. Shares the run's AbortController so Stop or "New prompt"
      // cancels slow companion requests as well as the chat stream.
      abortActiveGeneration();
      const controller = new AbortController();
      activeController = controller;
      const isAborted = (): boolean => controller.signal.aborted;
      const releaseController = (): void => {
        if (activeController === controller) activeController = null;
      };

      const providers = [
        createKnowledgeBaseProvider({
          enabled: settings.kbEnabled,
          collectionIds: useKnowledgeBaseStore.getState().boundCollectionIds,
        }),
      ];
      const blocks = await runContextProviders(providers, {
        query: input.draft,
        vars,
        signal: controller.signal,
      });
      if (isAborted()) {
        releaseController();
        return;
      }

      // Decide what actually fits before building the request (ADR-025).
      // `num_ctx` covers prompt *and* reply, and an over-long prompt is trimmed
      // from the front by Ollama without notice, so this is measured here
      // rather than discovered afterwards.
      const charsPerToken = useCalibrationStore.getState().ratioFor(input.model);
      const documentContext =
        input.contextSource === 'none' ? null : (vars[input.contextSource] ?? null);
      const nonDocVars: PromptVars =
        input.contextSource === 'none' ? vars : { ...vars, [input.contextSource]: '' };
      const baseInstruction =
        input.template === null
          ? input.draft
          : [
              applyTemplate(input.template.system, nonDocVars).trim(),
              applyTemplate(input.template.user, nonDocVars),
            ]
              .filter((part) => part !== '')
              .join('\n\n');
      const priorBlock =
        input.priorResult === undefined || input.priorResult.trim() === ''
          ? ''
          : `\n\n--- previous result ---\n${input.priorResult.trim()}`;
      const instruction = `${baseInstruction}${priorBlock}`;

      // Captured here, where the text is still in hand, and truncated before it
      // reaches storage — history is capped at 200 records in browser storage,
      // and a whole-document capture could evict the rest on its own.
      const excerpt = documentContext === null ? null : toContextExcerpt(documentContext);
      /*
       * Figures are charged to the budget before they are fetched.
       *
       * They cannot be fetched first — budgeting decides which chunks survive,
       * and a figure belonging to a trimmed chunk must not be sent. So the
       * count is an upper bound taken from the retrieved chunks, capped at
       * MAX_RUN_FIGURES. Over-reserving costs at most one excerpt;
       * under-reserving means Ollama silently trims the prompt's front, which
       * is the failure ADR-025 exists to prevent.
       */
      const canSeeFigures = input.visionModel !== undefined && input.visionModel !== null;
      const figuresInPlay = !canSeeFigures
        ? 0
        : Math.min(
            MAX_RUN_FIGURES,
            blocks.reduce(
              (sum, block) => sum + block.sources.filter((s) => s.figure !== undefined).length,
              0,
            ),
          );

      const budget = allocateBudget({
        contextLength: settings.contextLength,
        reservePct: settings.responseReservePct,
        instruction,
        documentContext,
        blocks,
        charsPerToken,
        imageCount: attachedImages + figuresInPlay,
      });

      if (budget.overflow) {
        releaseController();
        // Only the instruction is left and it still does not fit; sending it
        // would silently lose the very thing the user asked about.
        toasts.error(describeBudget(budget) ?? 'This prompt is too long for the context window.');
        useStreamStore.getState().reset();
        return;
      }

      // Fetched here — after budgeting fixed which chunks survive, before the
      // request is built from them.
      const sources = collectSources(budget.blocks);
      const runFigures = !canSeeFigures
        ? []
        : await fetchRunFigures(sources, input.visionModel ?? null, controller.signal);
      if (isAborted()) {
        releaseController();
        return;
      }

      const budgetedVars: PromptVars =
        input.contextSource === 'none' || budget.documentContext === documentContext
          ? vars
          : { ...vars, [input.contextSource]: budget.documentContext ?? '' };
      const retrieved: RetrievedContext | null =
        budget.blocks.length === 0 ? null : { text: assembleContextText(budget.blocks) };

      const request = buildChatRequest(
        runFigures.length === 0
          ? input
          : { ...input, images: [...(input.images ?? []), ...runFigures.map((f) => f.dataBase64)] },
        budgetedVars,
        {
          temperature: settings.temperature,
          topP: settings.topP,
          topK: settings.topK,
          seed: settings.seed,
          contextLength: settings.contextLength,
          streaming: settings.streaming,
        },
        retrieved,
      );

      streamOwner = controller;
      useStreamStore.getState().start({
        model: input.model,
        promptId: input.template?.id ?? null,
        sources,
        budget,
      });
      const wasReset = (): boolean =>
        streamOwner !== controller || useStreamStore.getState().status === 'idle';

      // rAF token batching: many NDJSON chunks per frame become one append.
      let pendingTokens = '';
      let frameHandle: number | null = null;
      const cancelFrame = (): void => {
        if (frameHandle !== null) {
          window.cancelAnimationFrame(frameHandle);
          frameHandle = null;
        }
        pendingTokens = '';
      };
      const flushTokens = (): void => {
        if (frameHandle !== null) {
          window.cancelAnimationFrame(frameHandle);
          frameHandle = null;
        }
        if (pendingTokens !== '') {
          useStreamStore.getState().appendToken(pendingTokens);
          pendingTokens = '';
        }
      };
      const onToken = (content: string): void => {
        pendingTokens += content;
        frameHandle ??= window.requestAnimationFrame(() => {
          frameHandle = null;
          const batch = pendingTokens;
          pendingTokens = '';
          if (!wasReset()) useStreamStore.getState().appendToken(batch);
        });
      };

      // Every terminal branch records the run exactly once (§11.1, ADR-021).
      // One run, one record — including cancelled and failed ones, whose
      // partial text is worth keeping and whose outcome explains it.
      let finalized = false;
      const finalize = (
        stats: GenerationStats | null,
        outcome: GenerationOutcome,
      ): string | null => {
        if (finalized) return null;
        finalized = true;
        const text = useStreamStore.getState().text;
        if (text === '' && stats === null && outcome === 'completed') return null;
        return useHistoryStore.getState().addRecord({
          prompt: input.draft,
          response: text,
          model: input.model,
          outcome,
          ...(input.template === null
            ? {}
            : { templateId: input.template.id, templateName: input.template.name }),
          ...(input.contextSource === 'none' ? {} : { contextSource: input.contextSource }),
          // The passage itself, bounded. `contextSource` alone records only
          // which *kind* of context was captured, which asserts provenance
          // while withholding the one thing that would establish it: a record
          // listing sources but not the text they were retrieved for cannot be
          // checked against anything later.
          ...(excerpt === null ? {} : { contextExcerpt: excerpt }),
          ...(stats === null ? {} : { stats }),
          ...(sources.length === 0 ? {} : { sources }),
        });
      };

      let doneStats: GenerationStats | null = null;
      try {
        for await (const event of getServices().ollama.chat(request, controller.signal)) {
          if (event.type === 'token') {
            onToken(event.content);
          } else {
            flushTokens();
            doneStats = event.stats;
          }
        }
      } catch (cause) {
        releaseController();
        if (wasReset()) {
          cancelFrame();
          return;
        }
        flushTokens();
        if (isAborted()) {
          useStreamStore.getState().cancel();
          finalize(null, 'cancelled');
          return;
        }
        const error = toAppError(
          cause,
          (c) =>
            new StreamError(
              'interrupted',
              'The stream was interrupted.',
              useStreamStore.getState().text,
              c,
            ),
        );
        useStreamStore.getState().fail(error);
        finalize(null, 'error');
        return;
      }
      releaseController();
      if (wasReset()) {
        cancelFrame();
        return;
      }
      flushTokens();

      if (doneStats !== null && !isAborted()) {
        useStreamStore.getState().complete(doneStats);
        // The only exact prompt size available anywhere: fold it back into the
        // per-model estimate so future budgets get more accurate (ADR-025).
        useCalibrationStore.getState().observe(
          input.model,
          request.messages.reduce((sum, message) => sum + message.content.length, 0),
          doneStats.promptEvalCount,
        );
        const recordId = finalize(doneStats, 'completed');
        // Attachments belong to the question that was just answered. Cleared
        // only on success, so a cancelled or failed run leaves them staged to
        // retry with rather than making the user re-attach.
        useAttachmentsStore.getState().clear();
        const text = useStreamStore.getState().text;
        const services = getServices();
        if (settings.autoCopy) {
          try {
            await services.clipboard.copy(text);
          } catch {
            // WKWebView/Safari reject clipboard writes without transient user
            // activation, and the Generate click has long expired by stream
            // completion. The toast's tap IS a gesture — copying from its
            // action succeeds where the silent write cannot.
            toasts.error('Auto-copy was blocked — this platform needs a tap.', {
              label: 'Copy result',
              onClick: () => {
                void getServices()
                  .clipboard.copy(text)
                  .catch(() => {
                    toasts.error('Copy failed — select the text and copy it manually.');
                  });
              },
            });
          }
        }
        if (settings.autoInsert && !isAborted()) {
          try {
            await services.office.insertAtCursor(markdownToPlainText(text));
            if (recordId !== null) {
              useHistoryStore.getState().markApplied(recordId, 'insert');
            }
          } catch {
            toasts.error('Auto-insert failed — use the Insert button instead.');
          }
        }
        return;
      }

      if (isAborted()) {
        // ADR-011: caller abort ends the generator silently — a normal stop.
        useStreamStore.getState().cancel();
        finalize(null, 'cancelled');
        return;
      }

      // Ended without `done` and without an abort: the connection dropped.
      useStreamStore
        .getState()
        .fail(
          new StreamError(
            'interrupted',
            'The connection closed before the response finished.',
            useStreamStore.getState().text,
          ),
        );
      finalize(null, 'error');
    },
    [toasts],
  );

  const stop = useCallback((): void => {
    abortActiveGeneration();
  }, []);

  const retry = useCallback((): void => {
    if (lastInput !== null) void generate(lastInput);
  }, [generate]);

  return useMemo(() => ({ generate, stop, retry, isActive }), [generate, stop, retry, isActive]);
}
