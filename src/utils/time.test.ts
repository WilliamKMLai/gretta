import { formatRelativeTime } from './time';

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-15T12:00:00Z');

  it('formats the near past compactly', () => {
    expect(formatRelativeTime('2026-07-15T11:59:40Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-15T11:45:00Z', now)).toBe('15 min ago');
    expect(formatRelativeTime('2026-07-15T09:00:00Z', now)).toBe('3 h ago');
    expect(formatRelativeTime('2026-07-13T12:00:00Z', now)).toBe('2 d ago');
  });

  it('falls back to a short date beyond a week', () => {
    expect(formatRelativeTime('2026-06-01T12:00:00Z', now)).toMatch(/Jun/);
  });

  it('returns empty for unparsable input', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});
