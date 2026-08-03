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
import { useCallback, useMemo, useRef } from 'react';
import { useAppToasts } from '../../components/toaster';
import { getServices } from '../../app/services';
import type { GenerationOutcome, GenerationStats, PromptContextVar } from '../../types/domain';
import { OfficeError, StreamError, toAppError } from '../../types/errors';
import { toContextExcerpt, useHistoryStore } from '../history';
import { assertRequiredContext, neededVars, requiredVars, type PromptVars } from '../prompts';
import { useSettingsStore } from '../settings';
import { useKnowledgeBaseStore } from '../knowledgebase';
import { assembleContextText, collectSources, runContextProviders } from './context/provider';
import { allocateBudget, describeBudget } from './context/budget';
import { useCalibrationStore } from './calibration.store';
import { createKnowledgeBaseProvider } from './context/knowledgeBaseProvider';
import { buildChatRequest, type GenerationInput, type RetrievedContext } from './request';
import { useStreamStore } from './stream.store';

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

export function useGeneration(): UseGenerationResult {
  const toasts = useAppToasts();
  const status = useStreamStore((state) => state.status);
  const isActive = status === 'connecting' || status === 'streaming';

  const controllerRef = useRef<AbortController | null>(null);
  const lastInputRef = useRef<GenerationInput | null>(null);

  const generate = useCallback(
    async (input: GenerationInput): Promise<void> => {
      const stream = useStreamStore.getState();
      if (stream.status === 'connecting' || stream.status === 'streaming') return;
      lastInputRef.current = input;

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

      // §16 pipeline: gather optional extra context (RAG) before building the
      // request. Bounded by its own signal so a slow companion can't stall the
      // run, and entirely non-fatal.
      const contextController = new AbortController();
      const providers = [
        createKnowledgeBaseProvider({
          enabled: settings.kbEnabled,
          collectionIds: useKnowledgeBaseStore.getState().boundCollectionIds,
        }),
      ];
      const blocks = await runContextProviders(providers, {
        query: input.draft,
        vars,
        signal: contextController.signal,
      });
      // Decide what actually fits before building the request (ADR-025).
      // `num_ctx` covers prompt *and* reply, and an over-long prompt is trimmed
      // from the front by Ollama without notice, so this is measured here
      // rather than discovered afterwards.
      const charsPerToken = useCalibrationStore.getState().ratioFor(input.model);
      const documentContext =
        input.contextSource === 'none' ? null : (vars[input.contextSource] ?? null);
      // Captured here, where the text is still in hand, and truncated before it
      // reaches storage — history is capped at 200 records in browser storage,
      // and a whole-document capture could evict the rest on its own.
      const excerpt = documentContext === null ? null : toContextExcerpt(documentContext);
      const budget = allocateBudget({
        contextLength: settings.contextLength,
        reservePct: settings.responseReservePct,
        instruction: input.draft,
        documentContext,
        blocks,
        charsPerToken,
      });

      if (budget.overflow) {
        // Only the instruction is left and it still does not fit; sending it
        // would silently lose the very thing the user asked about.
        toasts.error(describeBudget(budget) ?? 'This prompt is too long for the context window.');
        useStreamStore.getState().reset();
        return;
      }

      const budgetedVars: PromptVars =
        input.contextSource === 'none' || budget.documentContext === documentContext
          ? vars
          : { ...vars, [input.contextSource]: budget.documentContext ?? '' };
      const retrieved: RetrievedContext | null =
        budget.blocks.length === 0 ? null : { text: assembleContextText(budget.blocks) };

      const request = buildChatRequest(
        input,
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

      const sources = collectSources(budget.blocks);
      const controller = new AbortController();
      controllerRef.current = controller;
      useStreamStore.getState().start({
        model: input.model,
        promptId: input.template?.id ?? null,
        sources,
        budget,
      });

      // rAF token batching: many NDJSON chunks per frame become one append.
      let pendingTokens = '';
      let frameHandle: number | null = null;
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
          useStreamStore.getState().appendToken(batch);
        });
      };

      // Every terminal branch records the run exactly once (§11.1, ADR-021).
      // One run, one record — including cancelled and failed ones, whose
      // partial text is worth keeping and whose outcome explains it.
      let finalized = false;
      const finalize = (stats: GenerationStats | null, outcome: GenerationOutcome): void => {
        if (finalized) return;
        finalized = true;
        const text = useStreamStore.getState().text;
        if (text === '' && stats === null && outcome === 'completed') return;
        useHistoryStore.getState().addRecord({
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
        flushTokens();
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
        finalize(null, controller.signal.aborted ? 'cancelled' : 'error');
        controllerRef.current = null;
        return;
      }
      controllerRef.current = null;
      flushTokens();

      if (doneStats !== null) {
        useStreamStore.getState().complete(doneStats);
        // The only exact prompt size available anywhere: fold it back into the
        // per-model estimate so future budgets get more accurate (ADR-025).
        useCalibrationStore.getState().observe(
          input.model,
          request.messages.reduce((sum, message) => sum + message.content.length, 0),
          doneStats.promptEvalCount,
        );
        finalize(doneStats, 'completed');
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
        if (settings.autoInsert) {
          try {
            await services.office.insertAtCursor(text);
          } catch {
            toasts.error('Auto-insert failed — use the Insert button instead.');
          }
        }
        return;
      }

      if (controller.signal.aborted) {
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
    controllerRef.current?.abort();
  }, []);

  const retry = useCallback((): void => {
    const last = lastInputRef.current;
    if (last !== null) void generate(last);
  }, [generate]);

  return useMemo(() => ({ generate, stop, retry, isActive }), [generate, stop, retry, isActive]);
}
