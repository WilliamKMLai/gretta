/**
 * Step 5 of the LaTeX strip pipeline (strip.mts): environment handling.
 *
 * Runs after macro expansion and math sealing, so by this point `\begin{...}`
 * spans left in the text are exactly the ones that are actually environments
 * to make a prose decision about — math environments are already opaque
 * placeholders (seal.mts) and never reach any of the rules below.
 */
import { extractBraceArg } from '../brace-scan.mts';

const LIST_ENVIRONMENTS = ['itemize', 'enumerate', 'description'];
const CAPTION_ENVIRONMENTS = ['figure', 'table'];
const DROP_ENVIRONMENTS = ['tabular', 'tabularx', 'array', 'thebibliography'];

/** `\begin{itemize}`/`\end{itemize}` (etc.) wrapper removed, `\item` markers
 * turned into a leading `- ` so each entry reads as a line of prose. */
function handleListEnvironments(text: string): string {
  let result = text;
  for (const name of LIST_ENVIRONMENTS) {
    result = result
      .replace(new RegExp(`\\\\begin\\{${name}\\*?\\}`, 'gu'), '')
      .replace(new RegExp(`\\\\end\\{${name}\\*?\\}`, 'gu'), '');
  }
  return result.replace(/\\item\b(?:\[[^\]]*\])?\s*/gu, '\n- ');
}

/**
 * Pulls `\caption{...}` text out of a dropped environment's body before the
 * rest of it is discarded. Captions are the one part of a figure/table that
 * is ordinary prose describing what the content *is* — often the exact
 * sentence a retrieval query like "what was the hyperparameter grid" is
 * looking for — so they're kept as their own paragraph even though the
 * tabular/tikz source around them is noise.
 */
function extractCaptions(body: string): string {
  const captions: string[] = [];
  const pattern = /\\caption\*?(?:\[[^\]]*\])?\s*\{/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const openBrace = match.index + match[0].length - 1;
    const arg = extractBraceArg(body, openBrace);
    if (!arg) break; // unbalanced — nothing more to recover from this point
    if (arg.content.trim() !== '') captions.push(arg.content);
    pattern.lastIndex = arg.end;
  }
  return captions.length === 0 ? '' : `\n\n${captions.join('\n\n')}\n\n`;
}

/** figure/table: body dropped, any `\caption{...}` kept. An unclosed
 * instance is treated the same way, to the end of the (already
 * document-scoped) text. */
function handleCaptionEnvironments(text: string): string {
  let result = text;
  for (const name of CAPTION_ENVIRONMENTS) {
    result = result.replace(
      new RegExp(`\\\\begin\\{${name}\\*?\\}([\\s\\S]*?)\\\\end\\{${name}\\*?\\}`, 'gu'),
      (_whole: string, body: string) => extractCaptions(body),
    );
    result = result.replace(
      new RegExp(`\\\\begin\\{${name}\\*?\\}([\\s\\S]*)$`, 'u'),
      (_whole: string, body: string) => extractCaptions(body),
    );
  }
  return result;
}

/** tabular/tabularx/array/thebibliography: dropped entirely, no caption
 * logic — a caption belongs to the figure/table wrapping it, already
 * extracted by `handleCaptionEnvironments`, and these environments are
 * usually already gone as part of that body-discard; this catches any
 * occurring standalone. */
function handleDropEnvironments(text: string): string {
  let result = text;
  for (const name of DROP_ENVIRONMENTS) {
    result = result
      .replace(new RegExp(`\\\\begin\\{${name}\\*?\\}[\\s\\S]*?\\\\end\\{${name}\\*?\\}`, 'gu'), '')
      .replace(new RegExp(`\\\\begin\\{${name}\\*?\\}[\\s\\S]*$`, 'u'), '');
  }
  return result;
}

/** Unknown environments (abstract, quote, and anything not named above):
 * keep the body, drop just the `\begin`/`\end` wrapper (and any trailing
 * `[options]` on the opening tag). */
function dropUnknownEnvironmentWrappers(text: string): string {
  return text.replace(/\\begin\{[^}]*\}(?:\[[^\]]*\])?/gu, '').replace(/\\end\{[^}]*\}/gu, '');
}

/**
 * Applies the environment table in order: lists (wrapper stripped, items
 * marked), figure/table (caption kept, rest dropped), tabular-family and
 * bibliography (dropped outright), then anything left over keeps its body
 * and loses just the wrapper. Order matters — the drop/caption rules must
 * run before the generic fallback, or a table would fall through as
 * "unknown" and its raw tabular source would survive.
 */
export function handleEnvironments(text: string): string {
  let result = handleListEnvironments(text);
  result = handleCaptionEnvironments(result);
  result = handleDropEnvironments(result);
  result = dropUnknownEnvironmentWrappers(result);
  return result;
}
