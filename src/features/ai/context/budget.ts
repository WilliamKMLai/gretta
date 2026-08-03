/**
 * Prompt budget allocation (DECISIONS.md ADR-025).
 *
 * `num_ctx` covers the prompt *and* the reply, and Ollama trims an over-long
 * prompt from the front without telling anyone. ADR-022 fixed the ordering so
 * the front is the expendable part; this module decides what actually gets sent
 * so overflow is measured and reported instead of discovered later.
 *
 * The sacrifice order is deliberate and fixed:
 *
 *   1. the document context — bulky, and the user can see what they selected;
 *   2. the lowest-scoring retrieved excerpts, whole chunks at a time;
 *   3. never the instruction — a prompt without its instruction is not a
 *      smaller request, it is a different one, so that case blocks instead.
 *
 * Excerpts outrank the document deliberately: they were selected *because* they
 * matched, they are small, and dropping them silently while still citing them
 * is precisely the bug that motivated this work.
 */
import { estimateTokens, charsForTokens, trimMiddle } from '../../../utils/tokens';
import type { ContextBlock } from './provider';

/** Share of the prompt budget retrieved excerpts may collectively occupy. */
export const MAX_EXCERPT_SHARE = 0.5;

/** What was given up to make the request fit, for reporting to the user. */
export interface TrimNote {
  kind: 'document-trimmed' | 'document-dropped' | 'excerpt-dropped';
  detail: string;
}

export interface BudgetInput {
  /** `num_ctx` for this run. */
  contextLength: number;
  /** Percentage of the window held back for the reply. */
  reservePct: number;
  /** Instruction text (draft and/or rendered template) — never trimmed. */
  instruction: string;
  /** Document context, when a context source is selected. */
  documentContext: string | null;
  /** Provider output, best-scoring first within each block. */
  blocks: readonly ContextBlock[];
  /** Calibrated characters-per-token ratio for the model in use. */
  charsPerToken: number;
}

export interface BudgetResult {
  /** Tokens available for the prompt after reserving reply space. */
  limitTokens: number;
  /** Estimated prompt size after any trimming. */
  estimatedTokens: number;
  /** `estimatedTokens / limitTokens` as a percentage (may exceed 100). */
  usagePct: number;
  /** Document context to actually send. */
  documentContext: string | null;
  /** Blocks to actually send. */
  blocks: ContextBlock[];
  /** What was sacrificed, in the order it was given up. */
  trimmed: TrimNote[];
  /** True when the request cannot fit even with everything trimmable removed. */
  overflow: boolean;
}

function blockTokens(block: ContextBlock, charsPerToken: number): number {
  return estimateTokens(`${block.label}\n${block.text}`, charsPerToken);
}

/** Drops the weakest chunk from the weakest-scoring block, or null if none left. */
function dropWeakestExcerpt(blocks: ContextBlock[]): TrimNote | null {
  let target = -1;
  let worst = Number.POSITIVE_INFINITY;
  blocks.forEach((block, index) => {
    const last = block.sources.at(-1);
    const score = last?.score ?? 0;
    if (block.sources.length > 0 && score <= worst) {
      worst = score;
      target = index;
    }
  });
  if (target === -1) return null;

  const block = blocks[target];
  if (block === undefined) return null;
  const removed = block.sources.at(-1);
  const remaining = block.sources.slice(0, -1);
  if (remaining.length === 0) {
    blocks.splice(target, 1);
  } else {
    // Re-render the block text from the excerpts that survive, so the text and
    // the cited sources can never disagree.
    blocks[target] = {
      ...block,
      sources: remaining,
      text: remaining
        .map((chunk, i) => `[${String(i + 1)}] ${chunk.source}\n${chunk.text}`)
        .join('\n\n'),
    };
  }
  return {
    kind: 'excerpt-dropped',
    detail: removed === undefined ? 'one excerpt' : `${removed.source} (lowest match)`,
  };
}

/**
 * Decides what fits. Pure: returns the material to send plus a record of what
 * was given up; the caller reports it and sends the result.
 */
export function allocateBudget(input: BudgetInput): BudgetResult {
  const { charsPerToken } = input;
  const reserve = Math.min(90, Math.max(0, input.reservePct)) / 100;
  const limitTokens = Math.max(1, Math.floor(input.contextLength * (1 - reserve)));

  const instructionTokens = estimateTokens(input.instruction, charsPerToken);
  const trimmed: TrimNote[] = [];
  const blocks = input.blocks.map((block) => ({ ...block, sources: [...block.sources] }));
  let documentContext = input.documentContext;

  // Excerpts get a share cap of their own, so retrieval can never crowd out
  // the document entirely before the document has even been considered.
  const excerptCap = Math.floor(limitTokens * MAX_EXCERPT_SHARE);
  let excerptTokens = blocks.reduce((sum, block) => sum + blockTokens(block, charsPerToken), 0);
  while (excerptTokens > excerptCap && blocks.length > 0) {
    const note = dropWeakestExcerpt(blocks);
    if (note === null) break;
    trimmed.push(note);
    excerptTokens = blocks.reduce((sum, block) => sum + blockTokens(block, charsPerToken), 0);
  }

  const used = (): number =>
    instructionTokens +
    excerptTokens +
    (documentContext === null ? 0 : estimateTokens(documentContext, charsPerToken));

  // 1. Trim the document context.
  if (used() > limitTokens && documentContext !== null) {
    const room = limitTokens - instructionTokens - excerptTokens;
    if (room <= 0) {
      trimmed.push({ kind: 'document-dropped', detail: 'the document context did not fit' });
      documentContext = null;
    } else {
      const before = documentContext.length;
      documentContext = trimMiddle(documentContext, charsForTokens(room, charsPerToken));
      trimmed.push({
        kind: 'document-trimmed',
        detail: `document context shortened by ${(before - documentContext.length).toLocaleString()} characters`,
      });
    }
  }

  // 2. Give up excerpts, weakest first, only once the document is exhausted.
  while (used() > limitTokens && blocks.length > 0) {
    const note = dropWeakestExcerpt(blocks);
    if (note === null) break;
    trimmed.push(note);
    excerptTokens = blocks.reduce((sum, block) => sum + blockTokens(block, charsPerToken), 0);
  }

  const estimatedTokens = used();
  return {
    limitTokens,
    estimatedTokens,
    usagePct: Math.round((estimatedTokens / limitTokens) * 100),
    documentContext,
    blocks,
    trimmed,
    // 3. Only the instruction is left and it still does not fit.
    overflow: estimatedTokens > limitTokens,
  };
}

/** One-line summary for the pane, or null when nothing needs saying. */
export function describeBudget(result: BudgetResult): string | null {
  if (result.overflow) {
    return `This prompt needs about ${result.estimatedTokens.toLocaleString()} tokens but only ${result.limitTokens.toLocaleString()} are available. Raise the context length in Settings, or use a narrower context source.`;
  }
  if (result.trimmed.length === 0) return null;
  return `To fit the context window: ${result.trimmed.map((note) => note.detail).join('; ')}.`;
}
