import { joinUrl } from './url';

describe('joinUrl', () => {
  it('joins a clean base and slash-prefixed path', () => {
    expect(joinUrl('http://127.0.0.1:11434', '/api/version')).toBe(
      'http://127.0.0.1:11434/api/version',
    );
  });

  it('normalizes trailing and missing slashes', () => {
    expect(joinUrl('http://127.0.0.1:11434/', 'api/version')).toBe(
      'http://127.0.0.1:11434/api/version',
    );
    expect(joinUrl('http://127.0.0.1:11434///', '/api/tags')).toBe(
      'http://127.0.0.1:11434/api/tags',
    );
  });
});
