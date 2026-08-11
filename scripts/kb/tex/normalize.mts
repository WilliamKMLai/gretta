/**
 * Step 7 of the LaTeX strip pipeline (strip.mts): normalize accent escapes,
 * quotes, and dashes to Unicode, `~` to a plain space, and collapse
 * whitespace. Math is still sealed at this point (seal.mts), so none of
 * this can reach inside `$...$`/`\[...\]`/etc. and alter it.
 */

const SYMBOL_ACCENTS: Record<string, Record<string, string>> = {
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
  "'": {
    a: 'á',
    e: 'é',
    i: 'í',
    o: 'ó',
    u: 'ú',
    y: 'ý',
    A: 'Á',
    E: 'É',
    I: 'Í',
    O: 'Ó',
    U: 'Ú',
    c: 'ć',
    n: 'ń',
    s: 'ś',
    z: 'ź',
  },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  '=': { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū' },
  '.': { z: 'ż', Z: 'Ż' },
};

/** Letter-named accent commands support only the braced form (`\H{o}`, never
 * bare `\Ho`) — a bare form is ambiguous with the start of a longer command
 * name (`\Huge`) in a way the symbol accents above never are. */
const LETTER_ACCENTS: Record<string, Record<string, string>> = {
  H: { o: 'ő', u: 'ű', O: 'Ő', U: 'Ű' },
  c: { c: 'ç', C: 'Ç', s: 'ş', S: 'Ş' },
  v: { s: 'š', c: 'č', z: 'ž', e: 'ě', S: 'Š', C: 'Č', Z: 'Ž' },
  u: { a: 'ă', g: 'ğ' },
  k: { a: 'ą', e: 'ę' },
  r: { a: 'å', A: 'Å' },
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** `\i`/`\j` (dotless i/j, used as accent arguments so the dot doesn't
 * collide with the accent mark) resolve to plain "i"/"j" for lookup. */
function resolveAccent(map: Record<string, string>, rawBase: string): string | null {
  const base = rawBase.startsWith('\\') ? rawBase.slice(1) : rawBase;
  return map[base] ?? null;
}

function applyAccentMap(
  text: string,
  accent: string,
  map: Record<string, string>,
  allowBare: boolean,
): string {
  const escaped = escapeRegExp(accent);
  let result = text.replace(
    new RegExp(`\\\\${escaped}\\{(\\\\[ij]|.)\\}`, 'gu'),
    (whole: string, base: string) => resolveAccent(map, base) ?? whole,
  );
  if (allowBare) {
    result = result.replace(
      new RegExp(`\\\\${escaped}(\\\\[ij]|[a-zA-Z])`, 'gu'),
      (whole: string, base: string) => resolveAccent(map, base) ?? whole,
    );
  }
  return result;
}

/** `Bj\"{o}rk` → `Björk`, `Erd\H{o}s` → `Erdős`, `na\"{\i}ve` → `naïve`. */
export function normalizeAccents(text: string): string {
  let result = text;
  for (const [accent, map] of Object.entries(SYMBOL_ACCENTS)) {
    result = applyAccentMap(result, accent, map, true);
  }
  for (const [accent, map] of Object.entries(LETTER_ACCENTS)) {
    result = applyAccentMap(result, accent, map, false);
  }
  return result;
}

/** TeX's backtick/apostrophe quote convention → Unicode curly quotes. Doubled
 * forms are converted first so a pair isn't read as two singles. */
export function normalizeQuotes(text: string): string {
  return text.replace(/``/gu, '“').replace(/''/gu, '”').replace(/`/gu, '‘').replace(/'/gu, '’');
}

/** `---` (em dash) before `--` (en dash), so a triple isn't read as one en
 * dash plus a stray hyphen. */
export function normalizeDashes(text: string): string {
  return text.replace(/---/gu, '—').replace(/--/gu, '–');
}

/** A bare `~` at this point in the pipeline is always LaTeX's non-breaking
 * space — any `~` that was part of an accent command (`\~{n}`) was already
 * consumed by `normalizeAccents`, which only matches the backslash-prefixed
 * form. */
export function normalizeTilde(text: string): string {
  return text.replace(/~/gu, ' ');
}

/** `\,` `\;` `\!` (thin/thick/negative space, most often seen inside a
 * user macro's own body — e.g. `\newcommand{\unit}[2]{#1\,\textrm{#2}}`)
 * and `\ ` (explicit interword space) all become a plain space. None of
 * these match commands.mts's command regex — it requires a letter right
 * after the backslash — so without this they survive every other step and
 * leak into output as a literal backslash-comma/semicolon/bang/space. */
export function normalizeSpacingCommands(text: string): string {
  return text.replace(/\\[,;! ]/gu, ' ');
}

/** Collapses runs of horizontal whitespace and blank lines left behind by
 * macro expansion, heading extraction, and dropped commands/environments. */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
