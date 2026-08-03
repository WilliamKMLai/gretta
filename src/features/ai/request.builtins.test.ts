/**
 * Phase 8 exit gate: every built-in prompt produces a correct request payload.
 * Exercises the pure builder with fixed settings and canned context vars so
 * the snapshots pin the exact wire shape — messages (system interpolation,
 * blank-system drop), camelCase → wire option names, seed omission, and each
 * template's temperature default overriding settings.
 */
import { BUILTIN_PROMPTS } from '../prompts';
import { buildChatRequest, type RequestSettings } from './request';

const SETTINGS: RequestSettings = {
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  seed: null,
  contextLength: 4096,
  streaming: true,
};

const VARS = {
  selection: 'The mitochondria is the powerhouse of the cell.',
  paragraph: 'We done the experiment twice and it work both times.',
  document: 'Introduction. Methods. Results. Discussion.',
  input: 'Please emphasize the novelty of the approach.',
};

describe('per-built-in request payloads', () => {
  for (const template of BUILTIN_PROMPTS) {
    it(template.name, () => {
      const request = buildChatRequest(
        { template, draft: VARS.input, contextSource: 'none', model: 'llama3.1:8b' },
        VARS,
        SETTINGS,
      );
      expect(request).toMatchSnapshot();
    });
  }

  it('free prompt with a selection context block', () => {
    const request = buildChatRequest(
      { template: null, draft: VARS.input, contextSource: 'selection', model: 'llama3.1:8b' },
      VARS,
      SETTINGS,
    );
    expect(request).toMatchSnapshot();
  });
});
