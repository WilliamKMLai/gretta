/**
 * Pass 2 of the `.tex` reader (DECISIONS.md ADR-020 amendment): per-file
 * extraction against the folder's macro table (macros.mts). Order is
 * load-bearing — get it wrong and a later step parses inside content that
 * should have been sealed off:
 *
 *   1. Seal verbatim/lstlisting/`\verb` (seal.mts).
 *   2. Strip comments (macros.mts — shared with pass 1's definition scan).
 *   3. Scope to `\begin{document}...\end{document}` when present.
 *   4. Strip macro definitions, then expand macro invocations (macros.mts).
 *   4.5. Seal math — after expansion (so `\dsize` inside `$...$` still
 *        expands) and before environment/command handling (seal.mts).
 *   7a. Normalize accent escapes to Unicode — *before* command handling,
 *       out of step-number order (normalize.mts). Letter-named accents
 *       (`\H{o}`, `\'{e}`, the `\i`/`\j` dotless forms) are indistinguishable
 *       from an ordinary one-letter command until they've been resolved;
 *       run after step 6 instead, step 6's "unknown command" fallback would
 *       eat `\H{o}` as if it were an unrecognized command with a braced
 *       argument, dropping the `H` and losing the accent (`Erdős` →
 *       `Erdos`) before this step ever saw it.
 *   5. Environment handling (environments.mts).
 *   6. Command handling (commands.mts).
 *   7b. Normalize quotes/dashes/spacing-primitives(`\,` `\;` `\!` `\ `)/`~`/
 *       whitespace (normalize.mts) — these trigger on punctuation, not
 *       letters, so (unlike accents) they can't collide with step 6 and
 *       stay in the spec's given order. `\quad`/`\qquad` are letter-named,
 *       so they're handled inside step 6 instead (commands.mts) — by step
 *       7 they'd already have been eaten by the unknown-command fallback.
 *   8. Restore every sealed region.
 */
import { extractBraceArg } from '../brace-scan.mts';
import { stripComments, expandMacros, type MacroTable } from './macros.mts';
import { sealVerbatimAndCode, sealMath, stripMath, unseal, type SealedRegion } from './seal.mts';
import { handleEnvironments } from './environments.mts';
import { handleCommands } from './commands.mts';
import {
  normalizeAccents,
  normalizeQuotes,
  normalizeDashes,
  normalizeTilde,
  normalizeSpacingCommands,
  collapseWhitespace,
} from './normalize.mts';

/**
 * Math and citation/ref markup is preserved verbatim rather than stripped,
 * because this reader's user is authoring LaTeX: retrieved context that
 * still contains `\citep{pierce2019}` and `$b = 0.75$` is directly reusable
 * in their document, where stripped context is not. The mild embedding
 * noise is the accepted trade. This is the one choice in the design that is
 * cleanly reversible — flip this constant to strip both instead; nothing
 * else in this file needs to change either way.
 */
// `let`, not `const` — a `const` boolean literal narrows to the type `true`,
// which would make every `PRESERVE_MATH_AND_CITATIONS ? … : …` below look
// "always truthy" to the linter even after flipping the value to `false`.
// eslint-disable-next-line prefer-const -- see above: widened to `boolean` on purpose.
let PRESERVE_MATH_AND_CITATIONS = true;

const NEWCOMMAND_PATTERN =
  /\\(?:newcommand|renewcommand)\*?\s*\{?\\[a-zA-Z]+\}?\s*(?:\[\d+\]\s*(?:\[[^\]]*\])?)?\s*\{/gu;
const DEF_PATTERN = /\\def\s*\\[a-zA-Z]+\s*\{/gu;

/** Removes `\newcommand`/`\renewcommand`/`\def` definition statements from
 * body text — boilerplate, never prose, in either pass. Re-scans rather than
 * reusing pass 1's result: pass 1 read the raw file, pass 2 is scoped to the
 * document body at this point, and re-running a cheap regex scan keeps this
 * module independent of pass 1's intermediate state. */
function stripMacroDefinitions(text: string): string {
  return stripBraceCommandSpans(stripBraceCommandSpans(text, NEWCOMMAND_PATTERN), DEF_PATTERN);
}

function stripBraceCommandSpans(text: string, pattern: RegExp): string {
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(pattern.source, pattern.flags);
  while ((match = re.exec(text)) !== null) {
    const openBrace = match.index + match[0].length - 1;
    const arg = extractBraceArg(text, openBrace);
    if (!arg) break; // unbalanced — nothing more to recover from this point
    result += text.slice(cursor, match.index);
    cursor = arg.end;
    re.lastIndex = arg.end;
  }
  result += text.slice(cursor);
  return result;
}

/** Slices to the `\begin{document}...\end{document}` body when present
 * (skipping the preamble — and any macro-table noise in it, already
 * consumed by pass 1), else treats the whole file as body: an included
 * file has no document environment at all and must not be discarded. */
function scopeToDocumentBody(text: string): string {
  const begin = /\\begin\{document\}/u.exec(text);
  if (!begin) return text;
  const bodyStart = begin.index + begin[0].length;
  const end = /\\end\{document\}/u.exec(text.slice(bodyStart));
  return end ? text.slice(bodyStart, bodyStart + end.index) : text.slice(bodyStart);
}

/**
 * Runs the full 8-step pipeline against one file's raw source and the
 * folder's macro table, producing prose ready to chunk. Never throws —
 * malformed input degrades (an unbalanced brace stops that one local
 * transform) rather than aborting the whole file.
 */
export function stripTex(source: string, table: MacroTable): string {
  const sealed: SealedRegion[] = [];

  let text = sealVerbatimAndCode(source, sealed);
  text = stripComments(text);
  text = scopeToDocumentBody(text);
  text = stripMacroDefinitions(text);
  text = expandMacros(text, table);

  text = PRESERVE_MATH_AND_CITATIONS ? sealMath(text, sealed) : stripMath(text);
  text = normalizeAccents(text);

  text = handleEnvironments(text);
  text = handleCommands(text, PRESERVE_MATH_AND_CITATIONS);

  text = normalizeQuotes(text);
  text = normalizeDashes(text);
  text = normalizeSpacingCommands(text);
  text = normalizeTilde(text);
  text = collapseWhitespace(text);

  return unseal(text, sealed);
}
