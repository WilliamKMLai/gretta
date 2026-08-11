/**
 * Pass 1 (folder-scoped): the macro table shared across every `.tex` file in
 * an ingestion folder, plus the pass-2 expansion engine that consumes it
 * (DECISIONS.md ADR-020 amendment, "folder-scoped .tex macro expansion").
 *
 * A LaTeX project's macros are usually defined once in a main file's preamble
 * and used throughout files it `\input`s/`\include`s. Since this reader treats
 * every `.tex` file as its own independent document (no root-file detection,
 * no splicing — see the ADR), an included file read in isolation would emit
 * raw `\dsize{}`-style invocations into chunk text with no idea what they mean.
 * This module's `buildMacroTable` fixes that by reading every `.tex` file in
 * the folder up front and merging their definitions into one flat table before
 * any file is chunked; `expandMacros` then substitutes invocations against it.
 *
 * `stripComments` lives here (rather than in strip.mts, which depends on this
 * module) because pass 1 needs it too: scanning raw, comment-laden text for
 * `\newcommand`/`\def` would harvest commented-out definitions as if they were
 * live. Pass 2's step 2 reuses the same function at the same pipeline position.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MAX_SCAN_ITERATIONS, extractBraceArg } from '../brace-scan.mts';

/** Expansion rounds before a self-referential macro is left as literal text
 * (it then falls through pass 2's "unknown command" handling and disappears
 * rather than hanging ingestion). Suggested by the design: 8. */
export const MAX_MACRO_EXPANSION_DEPTH = 8;

/** A `\newcommand`/`\renewcommand`/`\def` definition, folder-table-ready. */
export interface MacroDefinition {
  name: string;
  /** Positional argument count (`\def` and no-bracket `\newcommand` are 0). */
  params: number;
  /** The `[default]` for an optional first argument, or null when none. */
  defaultFirstArg: string | null;
  body: string;
  /** Which file defined this — the collision warning names both. */
  source: string;
}

/** Folder-wide macro table: name → its (last-wins) definition. */
export type MacroTable = Map<string, MacroDefinition>;

/** A scanned file, in both forms `buildMacroTable` needs: the path to read
 * (`absolute`) and the path to name in warnings (`source`, folder-relative —
 * matches `index-store.mts`'s `scanAll()` shape so callers can pass it through
 * unchanged). */
export interface TexFileRef {
  absolute: string;
  source: string;
}

/** Strips a `%` comment to end of line. A `%` preceded by an odd number of
 * backslashes is itself escaped (`\\` pairs off as literal backslashes, so
 * the trailing one escapes the percent) and must survive as literal text. */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== '%') continue;
        let backslashes = 0;
        let j = i - 1;
        while (j >= 0 && line[j] === '\\') {
          backslashes += 1;
          j -= 1;
        }
        if (backslashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

interface RawSpan {
  start: number;
  end: number;
  definition: Omit<MacroDefinition, 'source'>;
}

const NEWCOMMAND_PATTERN =
  /\\(?:newcommand|renewcommand)\*?\s*\{?\\([a-zA-Z]+)\}?\s*(?:\[(\d+)\]\s*(?:\[([^\]]*)\])?)?\s*\{/gu;
const DEF_PATTERN = /\\def\s*\\([a-zA-Z]+)\s*\{/gu;

function scanPattern(
  text: string,
  pattern: RegExp,
  parseParams: (match: RegExpExecArray) => { params: number; defaultFirstArg: string | null },
): RawSpan[] {
  const spans: RawSpan[] = [];
  let match: RegExpExecArray | null;
  let iterations = 0;
  while ((match = pattern.exec(text)) !== null && iterations < MAX_SCAN_ITERATIONS) {
    iterations += 1;
    const name = match[1] ?? '';
    const openBrace = match.index + match[0].length - 1;
    const arg = extractBraceArg(text, openBrace);
    if (!arg) break; // unbalanced — nothing more to recover from this point
    const { params, defaultFirstArg } = parseParams(match);
    spans.push({
      start: match.index,
      end: arg.end,
      definition: { name, params, defaultFirstArg, body: arg.content },
    });
    pattern.lastIndex = arg.end;
  }
  return spans;
}

/**
 * Finds `\newcommand`/`\renewcommand`/`\def` spans in (already comment-free)
 * text. Returns the definitions found and the text with those spans removed —
 * definitions are boilerplate, never prose, in either pass.
 */
export function scanDefinitions(text: string): {
  definitions: Omit<MacroDefinition, 'source'>[];
  withoutDefinitions: string;
} {
  const newcommandSpans = scanPattern(text, NEWCOMMAND_PATTERN, (m) => ({
    params: m[2] !== undefined ? parseInt(m[2], 10) : 0,
    defaultFirstArg: m[3] ?? null,
  }));
  const defSpans = scanPattern(text, DEF_PATTERN, () => ({ params: 0, defaultFirstArg: null }));
  const spans = [...newcommandSpans, ...defSpans].sort((a, b) => a.start - b.start);

  let cursor = 0;
  const kept: string[] = [];
  for (const span of spans) {
    if (span.start < cursor) continue; // overlapping match — keep the earlier one, drop this one whole
    kept.push(text.slice(cursor, span.start));
    cursor = span.end;
  }
  kept.push(text.slice(cursor));

  return { definitions: spans.map((s) => s.definition), withoutDefinitions: kept.join('') };
}

/**
 * Reads every `.tex` file in the folder and merges their macro definitions
 * into one flat table. Processes files in source-path order so "last
 * definition wins" is deterministic regardless of the caller's ordering;
 * a name redefined by a *different* file than the one that last defined it
 * produces a warning naming both (same-file redefinition, e.g. a deliberate
 * `\renewcommand`, does not — that is ordinary, not a collision). A file that
 * cannot be read is skipped here; `parseFile`'s own read reports it.
 */
export async function buildMacroTable(
  files: readonly TexFileRef[],
): Promise<{ table: MacroTable; warnings: string[] }> {
  const table: MacroTable = new Map();
  const warnings: string[] = [];
  const ordered = [...files].sort((a, b) => a.source.localeCompare(b.source));
  for (const file of ordered) {
    let raw: string;
    try {
      raw = await readFile(file.absolute, 'utf8');
    } catch {
      continue;
    }
    const { definitions } = scanDefinitions(stripComments(raw));
    for (const def of definitions) {
      const existing = table.get(def.name);
      if (existing !== undefined && existing.source !== file.source) {
        warnings.push(
          `macro \\${def.name} is defined in both ${existing.source} and ${file.source} — using the definition from ${file.source}`,
        );
      }
      table.set(def.name, { ...def, source: file.source });
    }
  }
  return { table, warnings };
}

/** Stable fingerprint of a table's contents (order-independent), so
 * index-store.mts can detect "did the folder's macros change since the last
 * reindex" without comparing full tables. */
export function fingerprintMacroTable(table: MacroTable): string {
  const serialized = [...table.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, def]) => `${name} ${String(def.params)} ${def.defaultFirstArg ?? ''} ${def.body}`)
    .join('');
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32);
}

function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Expands macro invocations against `table`, depth-capped. Each round
 * substitutes every recognized `\name` (with its `#1..#n` positional args and,
 * for a `[default]`-declared first argument, either the bracketed call-site
 * value or the default) and re-scans the result, so a macro whose body invokes
 * another macro resolves within `maxDepth` rounds. A self-referential macro
 * (`\newcommand{\foo}{\foo bar}`) still matches every round — the loop does
 * not detect the cycle, it just stops after `maxDepth` rounds, which bounds
 * the work and guarantees termination either way; whatever `\foo` remains is
 * left for pass 2's "unknown command" handling to drop.
 */
export function expandMacros(
  text: string,
  table: MacroTable,
  maxDepth = MAX_MACRO_EXPANSION_DEPTH,
): string {
  if (table.size === 0) return text;
  const names = [...table.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`\\\\(${names.join('|')})(?![a-zA-Z])`, 'gu');

  let result = text;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    let changed = false;
    let output = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    let iterations = 0;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(result)) !== null && iterations < MAX_SCAN_ITERATIONS) {
      iterations += 1;
      const name = match[1] ?? '';
      const def = table.get(name);
      if (!def) {
        pattern.lastIndex = match.index + match[0].length;
        continue;
      }

      let scanPos = match.index + match[0].length;
      const args: string[] = [];

      if (def.defaultFirstArg !== null) {
        const bracket = /^\s*\[([^\]]*)\]/u.exec(result.slice(scanPos));
        if (bracket) {
          args.push(bracket[1] ?? '');
          scanPos += bracket[0].length;
        } else {
          args.push(def.defaultFirstArg);
        }
      }

      let ok = true;
      const remaining = def.params - args.length;
      for (let i = 0; i < remaining; i += 1) {
        const openBracket = /^\s*\{/u.exec(result.slice(scanPos));
        if (!openBracket) {
          ok = false;
          break;
        }
        const braceStart = scanPos + openBracket[0].length - 1;
        const arg = extractBraceArg(result, braceStart);
        if (!arg) {
          ok = false;
          break;
        }
        args.push(arg.content);
        scanPos = arg.end;
      }

      // The common `\dsize{}` boundary idiom on a zero-arg macro: an
      // immediately-following *empty* brace pair is swallowed; a non-empty
      // one is ordinary text and must not be treated as an argument.
      if (ok && def.params === 0 && result.slice(scanPos, scanPos + 2) === '{}') {
        scanPos += 2;
      }

      if (!ok) {
        output += result.slice(cursor, match.index + match[0].length);
        cursor = match.index + match[0].length;
        pattern.lastIndex = cursor;
        continue;
      }

      const body = def.body.replace(
        /#([1-9])/gu,
        (whole, n: string) => args[Number(n) - 1] ?? whole,
      );
      output += result.slice(cursor, match.index) + body;
      cursor = scanPos;
      pattern.lastIndex = cursor;
      changed = true;
    }
    output += result.slice(cursor);
    result = output;
    if (!changed) break;
  }
  return result;
}
