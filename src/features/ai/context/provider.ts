/**
 * Context-provider pipeline (ARCHITECTURE.md §16; DECISIONS.md ADR-020) — the
 * seam §16 reserved: "context assembly is isolated in useGeneration's build-
 * request step; add a ContextProvider[] pipeline there."
 *
 * This is the ADDITIVE stage. It runs AFTER the existing Office variable
 * capture and BEFORE `buildChatRequest`, contributing extra labeled context
 * blocks (RAG today; web/citation providers later) with visible provenance.
 * The Office capture is deliberately NOT reframed as a provider, so the M1
 * request-building contract and its per-built-in snapshot tests stay stable —
 * see ADR-020 for that boundary decision.
 *
 * This session ships the contract + a reference runner (testable in isolation).
 * The knowledge-base provider implementation and the `useGeneration` wiring
 * land with the approved ADR-020.
 */
import type { PromptContextVar } from '../../../types/domain';
import type { RetrievedChunk } from '../../../types/knowledgebase';

/** What a provider is asked to retrieve against. */
export interface ContextRequest {
  /** Retrieval query — typically the user's prompt draft. */
  query: string;
  /** Captured document variables, for providers that key off selection/doc. */
  vars: Readonly<Partial<Record<PromptContextVar, string>>>;
  /** Cancels slow providers; the pipeline also imposes its own timeout. */
  signal: AbortSignal;
}

/** One provider's contribution: text to inject plus provenance to display. */
export interface ContextBlock {
  /** Provider id, e.g. `knowledge-base`; used for ordering + debugging. */
  providerId: string;
  /** Human label rendered above the block, e.g. "Your knowledge base". */
  label: string;
  /** The text merged into the request (empty blocks are dropped). */
  text: string;
  /** Provenance surfaced in ResponseView for citation (may be empty). */
  sources: RetrievedChunk[];
}

/**
 * A source of extra generation context. Returns null to contribute nothing
 * (unconfigured, disabled, empty result, or a handled failure). A provider
 * must NEVER throw the whole generation down: retrieval is best-effort context
 * (ADR-020). The runner enforces this, but providers should also self-guard.
 */
export interface ContextProvider {
  readonly id: string;
  provide(request: ContextRequest): Promise<ContextBlock | null>;
}

/** Per-provider ceiling so one slow provider can't stall generation. */
export const PROVIDER_TIMEOUT_MS = 4_000;

function withTimeout(
  promise: Promise<ContextBlock | null>,
  timeoutMs: number,
): Promise<ContextBlock | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null); // a failed provider contributes nothing
      });
  });
}

/**
 * Runs providers concurrently, dropping nulls, empties, and any that fail or
 * exceed `PROVIDER_TIMEOUT_MS`. Output order matches provider order (stable),
 * so the assembled context is deterministic regardless of resolution order.
 */
export async function runContextProviders(
  providers: readonly ContextProvider[],
  request: ContextRequest,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): Promise<ContextBlock[]> {
  if (providers.length === 0) return [];
  const settled = await Promise.all(
    providers.map((provider) => withTimeout(provider.provide(request), timeoutMs)),
  );
  return settled.filter(
    (block): block is ContextBlock => block !== null && block.text.trim() !== '',
  );
}

/** Merges provider blocks into one labeled context string for the request. */
export function assembleContextText(blocks: readonly ContextBlock[]): string {
  return blocks.map((block) => `--- ${block.label} ---\n${block.text.trim()}`).join('\n\n');
}

/** Flattens provenance across blocks for ResponseView's sources list. */
export function collectSources(blocks: readonly ContextBlock[]): RetrievedChunk[] {
  return blocks.flatMap((block) => block.sources);
}
