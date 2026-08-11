/**
 * Opaque-region sealing for the LaTeX strip pipeline (strip.mts).
 *
 * Order is load-bearing: verbatim/lstlisting/`\verb` are sealed in pass 2's
 * step 1, before anything else runs, so comment-stripping and command
 * handling never parse inside code that only looks like LaTeX. Math is kept
 * verbatim too (the design's one reversible choice — PRESERVE_MATH_AND_CITATIONS
 * in strip.mts), but macro expansion must still reach inside it (`$\alpha =
 * \dsize$` should expand), so math is sealed separately, after macro
 * expansion and before environment/command handling — see `sealMath`. Both
 * pools restore together in one final `unseal` call.
 */
export interface SealedRegion {
  placeholder: string;
  content: string;
}

const MARK = '';

function sealOne(content: string, sealed: SealedRegion[]): string {
  const placeholder = `${MARK}GRETTA_SEALED_${String(sealed.length)}${MARK}`;
  sealed.push({ placeholder, content });
  return placeholder;
}

/** Restores every sealed placeholder back to its original text. Order is
 * irrelevant — each placeholder is wrapped in unique markers, so one can
 * never be a substring of another (`_SEALED_1_` vs `_SEALED_10_` still ends
 * in a different character before the closing mark). */
export function unseal(text: string, sealed: readonly SealedRegion[]): string {
  let result = text;
  for (const region of sealed) {
    result = result.split(region.placeholder).join(region.content);
  }
  return result;
}

/** Seals `\begin{name}...\end{name}` (optionally `\begin{name}[options]`),
 * star variant included. An unclosed instance seals to the end of the
 * (already document-scoped) text rather than leaking raw source. */
function sealEnvironment(
  text: string,
  name: string,
  sealed: SealedRegion[],
  allowOptions = false,
): string {
  const optPart = allowOptions ? '(?:\\[[^\\]]*\\])?' : '';
  const openTag = `\\\\begin\\{${name}\\*?\\}${optPart}`;
  const closeTag = `\\\\end\\{${name}\\*?\\}`;
  let result = text.replace(new RegExp(`${openTag}[\\s\\S]*?${closeTag}`, 'gu'), (whole: string) =>
    sealOne(whole, sealed),
  );
  result = result.replace(new RegExp(`${openTag}[\\s\\S]*$`, 'u'), (whole: string) =>
    sealOne(whole, sealed),
  );
  return result;
}

/** Seals `\verb|...|` (or `\verb*|...|`) for any delimiter character — the
 * character immediately after `\verb` opens and closes it, so this can't be
 * a fixed regex; it walks the text to find the matching close. */
function sealVerbInline(text: string, sealed: SealedRegion[]): string {
  const pattern = /\\verb\*?(.)/gu;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const delim = match[1] ?? '|';
    const closeIndex = text.indexOf(delim, match.index + match[0].length);
    if (closeIndex === -1) {
      pattern.lastIndex = match.index + match[0].length;
      continue;
    }
    result +=
      text.slice(cursor, match.index) + sealOne(text.slice(match.index, closeIndex + 1), sealed);
    cursor = closeIndex + 1;
    pattern.lastIndex = cursor;
  }
  result += text.slice(cursor);
  return result;
}

/** Step 1: seal verbatim regions before anything else can parse inside them. */
export function sealVerbatimAndCode(text: string, sealed: SealedRegion[]): string {
  let result = sealEnvironment(text, 'verbatim', sealed);
  result = sealEnvironment(result, 'lstlisting', sealed, true);
  result = sealVerbInline(result, sealed);
  return result;
}

const MATH_ENVIRONMENTS = [
  'equation',
  'align',
  'gather',
  'eqnarray',
  'displaymath',
  'multline',
  'alignat',
  'flalign',
];

/** Finds the next unescaped occurrence of `delim` starting at `from`,
 * skipping `\x` pairs so `\$` never counts as a delimiter. */
function findUnescapedDelimiter(text: string, from: number, delim: string): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(delim, i)) return i;
    i += 1;
  }
  return -1;
}

/** Seals `$$...$$` and `$...$`, escape-aware so `\$` is never mistaken for
 * a delimiter (a `%` comment inside math is real TeX behavior either way —
 * comments are stripped in the pipeline step before this one runs). */
function sealDollarMath(text: string, sealed: SealedRegion[]): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      result += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text[i] === '$') {
      const isDisplay = text[i + 1] === '$';
      const open = isDisplay ? '$$' : '$';
      const close = findUnescapedDelimiter(text, i + open.length, open);
      if (close === -1) {
        result += text.charAt(i);
        i += 1;
        continue;
      }
      result += sealOne(text.slice(i, close + open.length), sealed);
      i = close + open.length;
      continue;
    }
    result += text.charAt(i);
    i += 1;
  }
  return result;
}

/**
 * Step 4.5 (this pipeline's own addition, not one of the spec's numbered
 * steps): seals every math form — `$...$`, `$$...$$`, `\[...\]`, `\(...\)`,
 * and the amsmath display environments — so steps 5–6's generic/fallback
 * handling can never reach inside and mangle `\frac{a}{b}`-style markup.
 * Runs after macro expansion (so `\dsize` inside math still expands) and
 * before environment/command handling.
 */
export function sealMath(text: string, sealed: SealedRegion[]): string {
  let result = text;
  for (const name of MATH_ENVIRONMENTS) result = sealEnvironment(result, name, sealed);
  result = result.replace(/\\\[[\s\S]*?\\\]/gu, (whole: string) => sealOne(whole, sealed));
  result = result.replace(/\\\([\s\S]*?\\\)/gu, (whole: string) => sealOne(whole, sealed));
  result = sealDollarMath(result, sealed);
  return result;
}

/** Fallback for `PRESERVE_MATH_AND_CITATIONS = false` (strip.mts): math is
 * dropped outright rather than sealed, matching this reader's pre-macro-aware
 * behavior. Kept here since it shares `MATH_ENVIRONMENTS`. */
export function stripMath(text: string): string {
  let result = text
    .replace(/\$\$[\s\S]*?\$\$/gu, '')
    .replace(/\$[^$]*?\$/gu, '')
    .replace(/\\\[[\s\S]*?\\\]/gu, '')
    .replace(/\\\([\s\S]*?\\\)/gu, '');
  for (const name of MATH_ENVIRONMENTS) {
    result = result
      .replace(new RegExp(`\\\\begin\\{${name}\\*?\\}[\\s\\S]*?\\\\end\\{${name}\\*?\\}`, 'gu'), '')
      .replace(new RegExp(`\\\\begin\\{${name}\\*?\\}[\\s\\S]*$`, 'u'), '');
  }
  return result;
}
