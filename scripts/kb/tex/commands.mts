/**
 * Step 6 of the LaTeX strip pipeline (strip.mts): command handling.
 *
 * A single left-to-right scan dispatches each `\command` to one of four
 * treatments by name (preserve / heading / unwrap / drop-with-argument);
 * anything not in one of those lists falls through to the generic rule at
 * the bottom of the table. Citation/ref commands are preserved outright —
 * gated on `PRESERVE_MATH_AND_CITATIONS`, this pipeline's one reversible
 * design choice (see strip.mts) — so they must be excluded from the generic
 * fallback explicitly, or it would strip them like any other unrecognized
 * command with a brace argument.
 *
 * Nesting (`\textbf{Bold \emph{and italic}}`) is handled by re-running the
 * scan to a fixed point rather than recursing per match: unwrapping
 * `\textbf` exposes its argument's raw `\emph{...}` as ordinary top-level
 * text, which the next round then finds and unwraps in turn.
 */
import { extractBraceArg } from '../brace-scan.mts';

const HEADING_COMMANDS = ['section', 'subsection', 'subsubsection'];
const UNWRAP_COMMANDS = [
  'emph',
  'textbf',
  'textit',
  'texttt',
  'textsc',
  'underline',
  'footnote',
  'thanks',
];
const DROP_WITH_ARG_COMMANDS = [
  'includegraphics',
  'usepackage',
  'bibliography',
  'bibliographystyle',
  'maketitle',
  'input',
  'include',
  'xspace',
  'title',
  'author',
  'date',
  'hspace',
  'vspace',
];
const CITE_COMMANDS = ['cite', 'citep', 'citet'];
const PRESERVE_COMMANDS = [...CITE_COMMANDS, 'ref', 'eqref', 'autoref', 'label', 'pageref'];
// Letter-named spacing commands (symbol-named ones — \, \; \! — aren't
// matched by this file's command regex at all, since it requires a letter
// after the backslash; those are handled in normalize.mts instead). Without
// this, `\quad`/`\qquad` fall to the generic "unknown bareword → drop"
// rule and vanish with no replacement, silently joining the words on
// either side of them.
const SPACING_COMMANDS = ['quad', 'qquad'];

type Category = 'preserve' | 'heading' | 'unwrap' | 'drop' | 'spacing' | null;

function categoryFor(name: string, preserveCitations: boolean): Category {
  if (PRESERVE_COMMANDS.includes(name)) return preserveCitations ? 'preserve' : 'drop';
  if (HEADING_COMMANDS.includes(name)) return 'heading';
  if (UNWRAP_COMMANDS.includes(name)) return 'unwrap';
  if (DROP_WITH_ARG_COMMANDS.includes(name)) return 'drop';
  if (SPACING_COMMANDS.includes(name)) return 'spacing';
  return null; // falls through to the generic "unknown command" rule
}

const MAX_SCAN_ITERATIONS = 5000;

/** One left-to-right pass: dispatches every `\command` it finds by name and
 * returns the fully-rewritten text. Does not itself handle nesting — see
 * `handleCommands`, which repeats this to a fixed point. */
function handleCommandsOnce(text: string, preserveCitations: boolean): string {
  const pattern = /\\([a-zA-Z]+)\*?/gu;
  let output = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  let iterations = 0;
  while ((match = pattern.exec(text)) !== null && iterations < MAX_SCAN_ITERATIONS) {
    iterations += 1;
    const name = match[1] ?? '';
    let scanPos = match.index + match[0].length;

    // `\citep[pre][post]{key}` takes up to two optional brackets; every
    // other command takes at most one (`\section[short]{Long title}`).
    const maxBrackets = CITE_COMMANDS.includes(name) ? 2 : 1;
    let brackets = 0;
    while (brackets < maxBrackets) {
      const bracket = /^\s*\[[^\]]*\]/u.exec(text.slice(scanPos));
      if (!bracket) break;
      scanPos += bracket[0].length;
      brackets += 1;
    }

    let argContent: string | null = null;
    let argEnd = scanPos;
    const braceLookahead = /^\s*\{/u.exec(text.slice(scanPos));
    if (braceLookahead) {
      const braceStart = scanPos + braceLookahead[0].length - 1;
      const arg = extractBraceArg(text, braceStart);
      if (arg) {
        argContent = arg.content;
        argEnd = arg.end;
      }
    }

    const whole = text.slice(match.index, argEnd);
    const category = categoryFor(name, preserveCitations);
    let replacement: string;
    switch (category) {
      case 'preserve':
        replacement = whole;
        break;
      case 'heading':
        replacement = `\n\n${argContent ?? ''}\n\n`;
        break;
      case 'unwrap':
        replacement = argContent ?? '';
        break;
      case 'drop':
        replacement = '';
        break;
      case 'spacing':
        replacement = ' ';
        break;
      default:
        // Unknown command: a braced argument's text survives; a bare one
        // (no argument at all) is dropped outright.
        replacement = argContent ?? '';
    }

    output += text.slice(cursor, match.index) + replacement;
    cursor = argEnd;
    pattern.lastIndex = cursor;
  }
  output += text.slice(cursor);
  return output;
}

/** Repeats `handleCommandsOnce` until nothing changes (nested commands
 * resolve one unwrap per round) or `maxRounds` is hit — LaTeX inline
 * formatting is never nested deeply enough in practice to need more. */
export function handleCommands(text: string, preserveCitations: boolean, maxRounds = 4): string {
  let result = text;
  for (let round = 0; round < maxRounds; round += 1) {
    const next = handleCommandsOnce(result, preserveCitations);
    if (next === result) break;
    result = next;
  }
  return result;
}
