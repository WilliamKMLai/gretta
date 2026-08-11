/**
 * Entry point for the `.tex` reader (DECISIONS.md ADR-020 amendment).
 * Matches the shape every other format function in parse.mts has —
 * `(path: string) => Promise<ParseResult>` — plus an optional folder macro
 * table, threaded through from index-store.mts's pass-1 scan. `import type`
 * from parse.mts is erased at runtime (Node's type stripping), so this does
 * not create the runtime cycle a value import would.
 */
import { readFile } from 'node:fs/promises';
import { blocksFromPlainText } from '../blocks.mts';
import type { ParseResult } from '../parse.mts';
import { stripTex } from './strip.mts';
import type { MacroTable } from './macros.mts';

export { buildMacroTable, fingerprintMacroTable } from './macros.mts';
export type { MacroTable, MacroDefinition, TexFileRef } from './macros.mts';

/** Reads and parses a single `.tex` file into blocks, expanding it against
 * `macros` (the folder table; an empty table when omitted, e.g. a direct
 * call with no folder context). */
export async function parseTexFile(
  path: string,
  macros: MacroTable = new Map(),
): Promise<ParseResult> {
  const source = await readFile(path, 'utf8');
  const blocks = blocksFromPlainText(stripTex(source, macros));
  return blocks.length === 0
    ? { ok: false, reason: 'file has no extractable text after stripping LaTeX markup' }
    : { ok: true, blocks };
}
