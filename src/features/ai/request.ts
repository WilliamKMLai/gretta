/**
 * Pure ChatRequest construction (ARCHITECTURE.md §11.1 step "interpolate
 * template + build ChatRequest"). No React, no services, no stores — given
 * the run's input, the captured context variables, and the effective
 * settings, produce exactly the wire request. `useGeneration` calls this;
 * the per-built-in payload snapshot tests (Phase 8 exit gate) exercise it
 * directly.
 */
import type { ChatMessage, ChatRequest, OllamaOptions } from '../../services/ollama';
import type { ContextSource, GenerationOptions, PromptTemplate } from '../../types/domain';
import { applyTemplate, type PromptVars } from '../prompts';

export interface GenerationInput {
  /**
   * Previous response being refined (ADR-021). Refining starts a NEW run
   * seeded with the earlier output — it is not an appended chat turn — so the
   * text arrives as a clearly delimited block, exactly like document context.
   */
  priorResult?: string;
  /** The selected template, or null for a free prompt. */
  template: PromptTemplate | null;
  /** The prompt textarea contents. */
  draft: string;
  /** The context chip; drives the free prompt's context block. */
  contextSource: ContextSource;
  model: string;
  /**
   * Base64 images for this run (ADR-034), riding on the user message.
   *
   * Optional so that a run without images produces byte-identical output to
   * every version before this one — the property the per-built-in payload
   * snapshots are pinned against.
   */
  images?: readonly string[];
}

/**
 * Extra context assembled by the ContextProvider pipeline (ADR-020). Optional
 * and additive: when absent, request building is byte-identical to M1, which is
 * what keeps the per-built-in payload snapshots stable.
 */
export interface RetrievedContext {
  /**
   * Fully assembled excerpt text, already labeled per provider by
   * `runContextProviders`/`assembleContextText`. Labeling lives there so
   * multi-provider output stays consistent and is never double-wrapped here.
   */
  text: string;
}

/** The settings slice request building consumes. */
export interface RequestSettings extends GenerationOptions {
  streaming: boolean;
}

/** Settings ⊕ template defaults, mapped to Ollama's field names (§7.2). */
function toOllamaOptions(
  base: GenerationOptions,
  overrides: Partial<GenerationOptions> | undefined,
): OllamaOptions {
  const merged: GenerationOptions = { ...base, ...overrides };
  const options: OllamaOptions = {
    temperature: merged.temperature,
    top_p: merged.topP,
    top_k: merged.topK,
    num_ctx: merged.contextLength,
  };
  return merged.seed === null ? options : { ...options, seed: merged.seed };
}

/**
 * Template runs interpolate system + user (a blank system prompt is
 * dropped); free runs compose the draft with a labeled context block.
 */
/**
 * Attaches images to the user message, or returns it untouched.
 *
 * The key is omitted entirely rather than set to `[]` when there is nothing to
 * send, so a request built without images serialises exactly as it did before
 * ADR-034 — which is what keeps the built-in payload snapshots meaningful.
 */
function withImages(message: ChatMessage, images: readonly string[] | undefined): ChatMessage {
  return images === undefined || images.length === 0
    ? message
    : { ...message, images: [...images] };
}

function buildMessages(
  input: GenerationInput,
  vars: PromptVars,
  retrieved: RetrievedContext | null,
): ChatMessage[] {
  // Retrieved excerpts are appended as clearly delimited reference material —
  // never merged into the template's own instructions, and never trusted as
  // instructions themselves (§13.1: all of it is data).
  //
  // They go AFTER the document-context block on purpose. Ollama trims an
  // over-long prompt from the front, and a whole-document context can easily
  // dwarf `num_ctx`, so anything placed first is what gets silently dropped —
  // which showed up in testing as retrieval that was cited in the pane but
  // invisible to the model. Last position is both the safest from truncation
  // and the strongest for attention.
  const excerpts = retrieved === null ? '' : retrieved.text.trim();
  const prior =
    input.priorResult === undefined || input.priorResult.trim() === ''
      ? ''
      : input.priorResult.trim();

  if (input.template !== null) {
    const system = applyTemplate(input.template.system, vars).trim();
    const user =
      applyTemplate(input.template.user, vars) +
      (excerpts === '' ? '' : `\n\n${excerpts}`) +
      (prior === '' ? '' : `\n\n--- previous result ---\n${prior}`);
    const userMessage = withImages({ role: 'user', content: user }, input.images);
    return system === '' ? [userMessage] : [{ role: 'system', content: system }, userMessage];
  }
  const parts = [input.draft.trim()];
  if (input.contextSource !== 'none') {
    parts.push(`--- ${input.contextSource} ---`, (vars[input.contextSource] ?? '').trim());
  }
  if (excerpts !== '') parts.push(excerpts);
  if (prior !== '') parts.push('--- previous result ---', prior);
  return [withImages({ role: 'user', content: parts.join('\n\n') }, input.images)];
}

/** The single exchange (M1 scope) this run sends: settings ⊕ template defaults. */
export function buildChatRequest(
  input: GenerationInput,
  vars: PromptVars,
  settings: RequestSettings,
  retrieved: RetrievedContext | null = null,
): ChatRequest {
  return {
    model: input.model,
    messages: buildMessages(input, vars, retrieved),
    options: toOllamaOptions(
      {
        temperature: settings.temperature,
        topP: settings.topP,
        topK: settings.topK,
        seed: settings.seed,
        contextLength: settings.contextLength,
      },
      input.template?.defaults,
    ),
    stream: settings.streaming,
  };
}
