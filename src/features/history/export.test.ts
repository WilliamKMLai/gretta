/** Export tests (ADR-021): a result is only trustworthy with its provenance. */
import { describe, expect, it } from 'vitest';
import type { GenerationRecord } from '../../types/domain';
import { exportFilename, historyToJson, recordToJson, recordToMarkdown } from './export';

const record: GenerationRecord = {
  id: 'r1',
  createdAt: '2026-07-15T10:00:00.000Z',
  prompt: 'Tighten this paragraph',
  response: 'A tighter paragraph.',
  model: 'llama3',
  outcome: 'completed',
  templateName: 'Tidy up',
  stats: { totalDurationMs: 1200, evalCount: 42, promptEvalCount: 10, tokensPerSecond: 35 },
  sources: [
    {
      collectionId: 'refs',
      source: 'paper.pdf',
      locator: { page: 4, paragraph: null },
      text: 'excerpt one',
      score: 0.8,
    },
    {
      collectionId: 'refs',
      source: 'notes.md',
      locator: { page: null, paragraph: 2 },
      text: 'excerpt two',
      score: 0.7,
    },
  ],
};

describe('recordToMarkdown', () => {
  it('includes prompt, response, stats, and cited sources', () => {
    const md = recordToMarkdown(record);
    expect(md).toContain('# Tidy up');
    expect(md).toContain('## Prompt');
    expect(md).toContain('Tighten this paragraph');
    expect(md).toContain('## Response');
    expect(md).toContain('A tighter paragraph.');
    expect(md).toContain('1. paper.pdf, p. 4');
    expect(md).toContain('2. notes.md, ¶2');
    expect(md).toContain('42 tokens');
  });

  it('omits the sources section when nothing was retrieved', () => {
    const withoutSources: GenerationRecord = { ...record };
    delete withoutSources.sources;
    expect(recordToMarkdown(withoutSources)).not.toContain('## Sources');
  });

  it('marks a non-completed run so a partial response is explicable', () => {
    expect(recordToMarkdown({ ...record, outcome: 'cancelled' })).toContain('cancelled');
  });

  it('says so explicitly when there is no response text', () => {
    expect(recordToMarkdown({ ...record, response: '' })).toContain('_(no response)_');
  });
});

describe('recordToJson / historyToJson', () => {
  it('round-trips a record', () => {
    expect(JSON.parse(recordToJson(record))).toEqual(record);
  });

  it('wraps a whole history', () => {
    expect(JSON.parse(historyToJson([record]))).toEqual({ records: [record] });
  });
});

describe('exportFilename', () => {
  it('slugifies the prompt and dates the file', () => {
    expect(exportFilename(record, 'md')).toBe('tighten-this-paragraph-2026-07-15.md');
  });

  it('falls back to the template name when there is no prompt', () => {
    expect(exportFilename({ ...record, prompt: '' }, 'json')).toBe('tidy-up-2026-07-15.json');
  });

  it('always produces a usable name', () => {
    const bare: GenerationRecord = { ...record, prompt: '!!!' };
    delete bare.templateName;
    expect(exportFilename(bare, 'md')).toBe('generation-2026-07-15.md');
  });
});
