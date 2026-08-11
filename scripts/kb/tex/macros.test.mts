import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMacroTable,
  expandMacros,
  fingerprintMacroTable,
  scanDefinitions,
  stripComments,
} from './macros.mts';
import type { MacroTable } from './macros.mts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('stripComments', () => {
  it('strips an unescaped comment to end of line', () => {
    expect(stripComments('kept % dropped')).toBe('kept ');
  });

  it('keeps a single-escaped percent (odd backslash count) as literal', () => {
    expect(stripComments('61\\% to 78\\%')).toBe('61\\% to 78\\%');
  });

  it('strips a real comment following escaped percents on the same line', () => {
    expect(stripComments('61\\% to 78\\% % TODO: check')).toBe('61\\% to 78\\% ');
  });

  it('treats an even (0) backslash count before % as a real comment start', () => {
    expect(stripComments('plain % comment')).toBe('plain ');
  });
});

describe('scanDefinitions', () => {
  it('parses a zero-arg \\newcommand and removes it from the text', () => {
    const { definitions, withoutDefinitions } = scanDefinitions(
      '\\newcommand{\\dsize}{12,481}\nBody.',
    );
    expect(definitions).toEqual([
      { name: 'dsize', params: 0, defaultFirstArg: null, body: '12,481' },
    ]);
    expect(withoutDefinitions).not.toContain('newcommand');
    expect(withoutDefinitions).toContain('Body.');
  });

  it('parses a positional-argument \\newcommand', () => {
    const { definitions } = scanDefinitions('\\newcommand{\\unit}[2]{#1 #2}');
    expect(definitions).toEqual([
      { name: 'unit', params: 2, defaultFirstArg: null, body: '#1 #2' },
    ]);
  });

  it('parses an optional-first-argument \\newcommand with a default', () => {
    const { definitions } = scanDefinitions('\\newcommand{\\greet}[2][Hello]{#1, #2!}');
    expect(definitions).toEqual([
      { name: 'greet', params: 2, defaultFirstArg: 'Hello', body: '#1, #2!' },
    ]);
  });

  it('parses \\renewcommand the same way as \\newcommand', () => {
    const { definitions } = scanDefinitions('\\renewcommand{\\dsize}{99}');
    expect(definitions[0]).toMatchObject({ name: 'dsize', params: 0, body: '99' });
  });

  it('parses plain-TeX \\def as a zero-arg macro', () => {
    const { definitions } = scanDefinitions('\\def\\foo{bar}');
    expect(definitions).toEqual([{ name: 'foo', params: 0, defaultFirstArg: null, body: 'bar' }]);
  });

  it('removes multiple definitions and preserves surrounding prose', () => {
    const { withoutDefinitions } = scanDefinitions('A.\n\\newcommand{\\a}{1}\nB.\n\\def\\b{2}\nC.');
    expect(withoutDefinitions.replace(/\s+/gu, ' ').trim()).toBe('A. B. C.');
  });
});

function table(
  ...defs: { name: string; params: number; defaultFirstArg: string | null; body: string }[]
): MacroTable {
  return new Map(defs.map((def) => [def.name, { ...def, source: 'test.tex' }]));
}

describe('expandMacros', () => {
  it('substitutes a zero-arg macro, swallowing a trailing empty brace pair', () => {
    const t = table({ name: 'dsize', params: 0, defaultFirstArg: null, body: '12,481' });
    expect(expandMacros('N=\\dsize{} items', t)).toBe('N=12,481 items');
  });

  it('does not swallow a non-empty brace pair after a zero-arg macro', () => {
    const t = table({ name: 'dsize', params: 0, defaultFirstArg: null, body: '12,481' });
    expect(expandMacros('\\dsize{Introduction}', t)).toBe('12,481{Introduction}');
  });

  it('substitutes positional arguments in order', () => {
    const t = table({ name: 'unit', params: 2, defaultFirstArg: null, body: '#1 #2' });
    expect(expandMacros('\\unit{80}{token}', t)).toBe('80 token');
  });

  it('uses the declared default when an optional first argument is omitted', () => {
    const t = table({ name: 'greet', params: 2, defaultFirstArg: 'Hello', body: '#1, #2!' });
    expect(expandMacros('\\greet{World}', t)).toBe('Hello, World!');
    expect(expandMacros('\\greet[Hi]{World}', t)).toBe('Hi, World!');
  });

  it('does not substitute #1 inside an argument value that itself contains "#1"', () => {
    const t = table({ name: 'wrap', params: 2, defaultFirstArg: null, body: '#1 then #2' });
    expect(expandMacros('\\wrap{uses #1 literally}{done}', t)).toBe('uses #1 literally then done');
  });

  it('resolves a macro whose body invokes another macro', () => {
    const t = table(
      { name: 'a', params: 0, defaultFirstArg: null, body: 'X' },
      { name: 'b', params: 0, defaultFirstArg: null, body: '\\a Y' },
    );
    expect(expandMacros('\\b', t)).toBe('X Y');
  });

  it('leaves a call with too few arguments untouched rather than guessing', () => {
    const t = table({ name: 'unit', params: 2, defaultFirstArg: null, body: '#1 #2' });
    expect(expandMacros('\\unit{80}', t)).toBe('\\unit{80}');
  });

  it('does not match a macro name that is a prefix of a longer command', () => {
    const t = table({ name: 'a', params: 0, defaultFirstArg: null, body: 'X' });
    expect(expandMacros('\\ab', t)).toBe('\\ab');
  });

  it('terminates on a self-referential macro instead of hanging (cycle safety)', () => {
    const t = table({ name: 'foo', params: 0, defaultFirstArg: null, body: '\\foo bar' });
    const start = Date.now();
    const result = expandMacros('\\foo', t, 8);
    expect(Date.now() - start).toBeLessThan(2000);
    // Bounded by maxDepth rounds of growth, then left for later "unknown
    // command" handling to drop — never grows without bound.
    expect(result.length).toBeLessThan(200);
  });

  it('returns the input unchanged when the table is empty', () => {
    expect(expandMacros('\\dsize{} items', new Map())).toBe('\\dsize{} items');
  });
});

describe('fingerprintMacroTable', () => {
  it('is stable regardless of Map insertion order', () => {
    const a: MacroTable = new Map([
      ['a', { name: 'a', params: 0, defaultFirstArg: null, body: '1', source: 'x.tex' }],
      ['b', { name: 'b', params: 0, defaultFirstArg: null, body: '2', source: 'x.tex' }],
    ]);
    const b: MacroTable = new Map([
      ['b', { name: 'b', params: 0, defaultFirstArg: null, body: '2', source: 'x.tex' }],
      ['a', { name: 'a', params: 0, defaultFirstArg: null, body: '1', source: 'x.tex' }],
    ]);
    expect(fingerprintMacroTable(a)).toBe(fingerprintMacroTable(b));
  });

  it('changes when a definition changes', () => {
    const a: MacroTable = new Map([
      ['a', { name: 'a', params: 0, defaultFirstArg: null, body: '1', source: 'x.tex' }],
    ]);
    const b: MacroTable = new Map([
      ['a', { name: 'a', params: 0, defaultFirstArg: null, body: '2', source: 'x.tex' }],
    ]);
    expect(fingerprintMacroTable(a)).not.toBe(fingerprintMacroTable(b));
  });
});

describe('buildMacroTable', () => {
  const dir = join(FIXTURES, 'collision');

  it('warns when two different files define the same macro, naming both', async () => {
    const { table: built, warnings } = await buildMacroTable([
      { absolute: join(dir, 'paper-a.tex'), source: 'paper-a.tex' },
      { absolute: join(dir, 'paper-b.tex'), source: 'paper-b.tex' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('paper-a.tex');
    expect(warnings[0]).toContain('paper-b.tex');
    expect(warnings[0]).toContain('threshold');
    // Last definition wins, by source path order — 'paper-b.tex' sorts after 'paper-a.tex'.
    expect(built.get('threshold')?.body).toBe('0.8');
  });

  it('is order-independent: the same warning and winner regardless of input order', async () => {
    const { table: built, warnings } = await buildMacroTable([
      { absolute: join(dir, 'paper-b.tex'), source: 'paper-b.tex' },
      { absolute: join(dir, 'paper-a.tex'), source: 'paper-a.tex' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(built.get('threshold')?.body).toBe('0.8');
  });

  it('does not warn when the folder has no collisions', async () => {
    const { warnings } = await buildMacroTable([
      { absolute: join(dir, 'paper-a.tex'), source: 'paper-a.tex' },
    ]);
    expect(warnings).toEqual([]);
  });
});
