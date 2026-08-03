import type { PromptTemplate } from '../../types/domain';
import { OfficeError } from '../../types/errors';
import {
  applyTemplate,
  assertRequiredContext,
  neededVars,
  referencedVars,
  requiredVars,
  requirementError,
  unknownPlaceholders,
} from './template';

const template = (overrides: Partial<PromptTemplate> = {}): PromptTemplate => ({
  id: 't1',
  name: 'Test',
  category: 'editing',
  description: '',
  system: 'You edit.',
  user: 'Edit: {{selection}}',
  requires: ['selection'],
  builtIn: false,
  ...overrides,
});

describe('applyTemplate', () => {
  it('substitutes every occurrence literally', () => {
    expect(applyTemplate('Fix {{selection}} and again {{selection}}.', { selection: 'this' })).toBe(
      'Fix this and again this.',
    );
  });

  it('missing vars become empty strings', () => {
    expect(applyTemplate('A{{input}}B', {})).toBe('AB');
  });

  it('never interprets replacement-pattern characters', () => {
    expect(applyTemplate('X {{input}} Y', { input: 'costs $& and $1' })).toBe(
      'X costs $& and $1 Y',
    );
  });

  it('substituted values are not re-scanned', () => {
    expect(applyTemplate('{{selection}}', { selection: 'literal {{input}}', input: 'BAD' })).toBe(
      'literal {{input}}',
    );
  });

  it('leaves unknown braces untouched', () => {
    expect(applyTemplate('{{unknown}} stays', {})).toBe('{{unknown}} stays');
  });
});

describe('referencedVars', () => {
  it('collects the distinct variables in order of first appearance', () => {
    expect(referencedVars('{{document}} {{input}} {{document}}')).toEqual(['document', 'input']);
  });

  it('returns empty for plain text', () => {
    expect(referencedVars('no placeholders here')).toEqual([]);
  });
});

describe('unknownPlaceholders', () => {
  it('reports typos and stray whitespace but not valid names', () => {
    expect(unknownPlaceholders('{{selection}} {{selektion}} {{ selection }} {{input}}')).toEqual([
      'selektion',
      ' selection ',
    ]);
  });

  it('deduplicates and preserves first-appearance order', () => {
    expect(unknownPlaceholders('{{b}} {{a}} {{b}}')).toEqual(['b', 'a']);
  });

  it('returns empty when every placeholder is known', () => {
    expect(unknownPlaceholders('{{selection}} and {{document}}')).toEqual([]);
  });
});

describe('neededVars', () => {
  it('template runs need requires ∪ referenced placeholders', () => {
    const t = template({ system: 'Context: {{document}}', user: 'Do {{input}}' });
    expect(neededVars(t, 'none')).toEqual(new Set(['selection', 'document', 'input']));
  });

  it('template runs ignore the context chip', () => {
    expect(neededVars(template(), 'paragraph')).toEqual(new Set(['selection']));
  });

  it('free runs need input plus the chip source', () => {
    expect(neededVars(null, 'paragraph')).toEqual(new Set(['input', 'paragraph']));
  });

  it("free runs with chip 'none' need only input", () => {
    expect(neededVars(null, 'none')).toEqual(new Set(['input']));
  });
});

describe('requiredVars', () => {
  it('template runs require exactly template.requires', () => {
    expect(requiredVars(template({ requires: ['selection', 'input'] }), 'document')).toEqual([
      'selection',
      'input',
    ]);
  });

  it('free runs require input, plus the chip source when set', () => {
    expect(requiredVars(null, 'none')).toEqual(['input']);
    expect(requiredVars(null, 'selection')).toEqual(['input', 'selection']);
  });
});

describe('assertRequiredContext', () => {
  it('passes when every required var is non-blank', () => {
    expect(() => {
      assertRequiredContext(['selection', 'input'], { selection: 'text', input: 'go' });
    }).not.toThrow();
  });

  it('throws the typed error for the first missing document var', () => {
    expect(() => {
      assertRequiredContext(['selection'], { selection: '   ' });
    }).toThrow(OfficeError);
    try {
      assertRequiredContext(['paragraph', 'document'], {});
    } catch (error) {
      expect(error).toBeInstanceOf(OfficeError);
      expect((error as OfficeError).message).toBe(
        'Place the cursor in a paragraph with text first.',
      );
    }
  });

  it('never throws for input — that is UI-level feedback', () => {
    expect(() => {
      assertRequiredContext(['input'], {});
    }).not.toThrow();
  });
});

describe('requirementError', () => {
  it('maps each document var to its kind and message', () => {
    expect(requirementError('selection').kind).toBe('no-selection');
    expect(requirementError('paragraph').kind).toBe('no-selection');
    expect(requirementError('document').kind).toBe('no-document');
  });
});
