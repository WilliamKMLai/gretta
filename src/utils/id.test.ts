import { newId } from './id';

describe('newId', () => {
  it('returns unique UUID-shaped ids', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
