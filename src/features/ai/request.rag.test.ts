/**
 * Retrieved-context integration in request building (ADR-020). The critical
 * guarantee: with no retrieval the payload is byte-identical to M1, so the
 * per-built-in snapshots stay valid.
 */
import { describe, expect, it } from 'vitest';
import type { PromptTemplate } from '../../types/domain';
import { buildChatRequest, type GenerationInput, type RequestSettings } from './request';

const settings: RequestSettings = {
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  seed: null,
  contextLength: 2048,
  streaming: true,
};

const template: PromptTemplate = {
  id: 'tidy',
  name: 'Tidy',
  category: 'editing',
  description: 'Tidy up text',
  system: 'You are an editor.',
  user: 'Improve: {{selection}}',
  requires: ['selection'],
  builtIn: true,
};

const freeInput: GenerationInput = {
  template: null,
  draft: 'Explain photosynthesis',
  contextSource: 'none',
  model: 'llama3',
};

describe('buildChatRequest with retrieved context', () => {
  it('is unchanged when nothing is retrieved (M1 contract preserved)', () => {
    const withNull = buildChatRequest(freeInput, {}, settings, null);
    const withoutArg = buildChatRequest(freeInput, {}, settings);
    expect(withNull).toEqual(withoutArg);
    expect(withNull.messages[0]?.content).toBe('Explain photosynthesis');
  });

  it('appends excerpts to a free-prompt user message', () => {
    const request = buildChatRequest(freeInput, {}, settings, {
      text: '--- Excerpts ---\n[1] paper.pdf, p. 2\nGreen light is reflected.',
    });
    const content = request.messages[0]?.content ?? '';
    expect(content.startsWith('Explain photosynthesis')).toBe(true);
    expect(content).toContain('paper.pdf');
  });

  /**
   * Regression: excerpts placed before a whole-document context block were the
   * first thing Ollama dropped when the prompt exceeded `num_ctx`, so the pane
   * cited sources the model had never seen. Excerpts must sit AFTER the bulky
   * document block.
   */
  it('puts excerpts after the document block, so truncation eats the document first', () => {
    const request = buildChatRequest(
      { ...freeInput, contextSource: 'document' },
      { document: 'A very long document.' },
      settings,
      { text: 'RETRIEVED EXCERPT' },
    );
    const content = request.messages[0]?.content ?? '';
    expect(content.indexOf('--- document ---')).toBeLessThan(content.indexOf('RETRIEVED EXCERPT'));
  });

  it('adds excerpts to the user message of a template run, never the system prompt', () => {
    const request = buildChatRequest(
      { ...freeInput, template, draft: '' },
      { selection: 'some text' },
      settings,
      { text: 'RETRIEVED' },
    );
    expect(request.messages[0]).toEqual({ role: 'system', content: 'You are an editor.' });
    expect(request.messages[1]?.content).toBe('Improve: some text\n\nRETRIEVED');
  });

  it('keeps the document context block alongside retrieved excerpts', () => {
    const request = buildChatRequest(
      { ...freeInput, contextSource: 'selection' },
      { selection: 'the selected words' },
      settings,
      { text: 'RETRIEVED' },
    );
    const content = request.messages[0]?.content ?? '';
    expect(content).toContain('RETRIEVED');
    expect(content).toContain('--- selection ---');
    expect(content).toContain('the selected words');
  });
});
