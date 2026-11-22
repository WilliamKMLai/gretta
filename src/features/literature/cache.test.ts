/**
 * Literature cache tests (DECISIONS.md ADR-028). Tests use jsdom's real
 * `localStorage`, same as the rest of `services/storage`'s test suite.
 */
import { STORAGE_KEYS } from '../../services/storage';
import type { AssessedRecord } from '../../types/literature';
import {
  cacheKey,
  clearCache,
  enabledSourceKeys,
  hashPassage,
  listEntries,
  readCache,
  writeCache,
} from './cache';
import type { CacheEntry } from './cache';

beforeEach(() => {
  window.localStorage.clear();
});

function record(id: string): AssessedRecord {
  return {
    record: {
      id,
      doi: `10.1/${id}`,
      pmid: null,
      arxivId: null,
      openAlexId: null,
      title: `Paper ${id}`,
      authors: [],
      containerTitle: null,
      issued: null,
      abstract: 'an abstract',
      type: 'article',
      url: null,
      discoveredVia: 'pubmed',
    },
    signals: { openAlex: null, pubmed: null, crossref: null },
    updates: { checked: false, updates: [] },
    relevance: 0.5,
    stance: null,
    tier: 'queued',
  };
}

function entryPayload(
  id: string,
  overrides: Partial<Omit<CacheEntry, 'key' | 'storedAt'>> = {},
): Omit<CacheEntry, 'key' | 'storedAt'> {
  return {
    results: [record(id)],
    ranking: 'semantic',
    hiddenCount: 0,
    rankingNote: null,
    sentQueries: [{ source: 'PubMed', query: 'q' }],
    failedSources: [],
    query: 'cats',
    sources: ['pubmed'],
    fromYear: null,
    resultsPerSource: 50,
    passageHash: hashPassage('a passage'),
    ...overrides,
  };
}

describe('hashPassage', () => {
  it('is stable for the same text', () => {
    expect(hashPassage('the selected passage')).toBe(hashPassage('the selected passage'));
  });

  it('differs for different text', () => {
    expect(hashPassage('the selected passage')).not.toBe(hashPassage('a different passage'));
  });
});

describe('cacheKey', () => {
  it('is stable for the same inputs', () => {
    expect(cacheKey('cats', ['pubmed', 'openalex'], 2020, 50)).toBe(
      cacheKey('cats', ['pubmed', 'openalex'], 2020, 50),
    );
  });

  it('is order-independent over the source set', () => {
    expect(cacheKey('cats', ['openalex', 'pubmed'], 2020, 50)).toBe(
      cacheKey('cats', ['pubmed', 'openalex'], 2020, 50),
    );
  });

  it.each([
    ['a different query', ['dogs', ['pubmed'], 2020, 50]],
    ['a different source set', ['cats', ['pubmed', 'openalex'], 2020, 50]],
    ['a different fromYear', ['cats', ['pubmed'], 2021, 50]],
    ['a different resultsPerSource', ['cats', ['pubmed'], 2020, 20]],
  ] as const)(
    'differs on %s',
    (_label, args: readonly [string, readonly string[], number, number]) => {
      const base = cacheKey('cats', ['pubmed'], 2020, 50);
      expect(cacheKey(...args)).not.toBe(base);
    },
  );
});

describe('enabledSourceKeys', () => {
  it('returns only the keys that are true', () => {
    expect(enabledSourceKeys({ pubmed: true, biorxiv: false, openalex: true })).toEqual([
      'pubmed',
      'openalex',
    ]);
  });
});

describe('readCache / writeCache', () => {
  it('is a miss before anything is written', async () => {
    await expect(readCache(cacheKey('cats', ['pubmed'], null, 50))).resolves.toBeNull();
  });

  it('round-trips a written entry', async () => {
    const key = cacheKey('cats', ['pubmed'], null, 50);
    await writeCache(key, entryPayload('a'));
    const entry = await readCache(key);
    expect(entry?.results[0]?.record.id).toBe('a');
    expect(entry?.ranking).toBe('semantic');
    expect(entry?.sentQueries).toEqual([{ source: 'PubMed', query: 'q' }]);
  });

  it('round-trips biorxiv and medrxiv discoveredVia values', async () => {
    const key = cacheKey('preprints', ['biorxiv', 'medrxiv'], null, 20);
    const bio = record('bio-1');
    const med = record('med-1');
    bio.record.discoveredVia = 'biorxiv';
    med.record.discoveredVia = 'medrxiv';

    await writeCache(key, entryPayload('bio-1', { results: [bio, med] }));
    const entry = await readCache(key);

    expect(entry?.results.map((item) => item.record.discoveredVia)).toEqual(['biorxiv', 'medrxiv']);
  });

  it('running the same search twice would hit the second time', async () => {
    const key = cacheKey('cats', ['pubmed'], null, 50);
    expect(await readCache(key)).toBeNull();
    await writeCache(key, entryPayload('a'));
    expect(await readCache(key)).not.toBeNull();
  });

  it('a miss on any of query/sources/fromYear/resultsPerSource', async () => {
    await writeCache(cacheKey('cats', ['pubmed'], null, 50), entryPayload('a'));
    expect(await readCache(cacheKey('dogs', ['pubmed'], null, 50))).toBeNull();
    expect(await readCache(cacheKey('cats', ['openalex'], null, 50))).toBeNull();
    expect(await readCache(cacheKey('cats', ['pubmed'], 2020, 50))).toBeNull();
    expect(await readCache(cacheKey('cats', ['pubmed'], null, 20))).toBeNull();
  });

  it('replaces an existing entry for the same key rather than duplicating it', async () => {
    const key = cacheKey('cats', ['pubmed'], null, 50);
    await writeCache(key, entryPayload('a'));
    await writeCache(key, entryPayload('b'));
    const entry = await readCache(key);
    expect(entry?.results).toHaveLength(1);
    expect(entry?.results[0]?.record.id).toBe('b');
  });

  it('an entry within the 24h TTL is a hit; one past it is a miss and is removed', async () => {
    vi.useFakeTimers();
    try {
      const key = cacheKey('cats', ['pubmed'], null, 50);
      await writeCache(key, entryPayload('a'));

      vi.advanceTimersByTime(23 * 60 * 60 * 1000);
      expect(await readCache(key)).not.toBeNull();

      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      expect(await readCache(key)).toBeNull();

      // Dropped from storage on the way out, not just treated as a miss.
      const raw = window.localStorage.getItem(STORAGE_KEYS.literatureCache) ?? '';
      const stored = JSON.parse(raw) as { data: { entries: unknown[] } };
      expect(stored.data.entries).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest entry once the 21st distinct search is cached', async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 20; i += 1) {
        await writeCache(
          cacheKey(`q${String(i)}`, ['pubmed'], null, 50),
          entryPayload(`e${String(i)}`),
        );
        vi.advanceTimersByTime(1000);
      }
      expect(await readCache(cacheKey('q0', ['pubmed'], null, 50))).not.toBeNull();

      await writeCache(cacheKey('q20', ['pubmed'], null, 50), entryPayload('e20'));

      expect(await readCache(cacheKey('q0', ['pubmed'], null, 50))).toBeNull();
      expect(await readCache(cacheKey('q1', ['pubmed'], null, 50))).not.toBeNull();
      expect(await readCache(cacheKey('q20', ['pubmed'], null, 50))).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hand-corrupted payload yields a miss rather than a crash', async () => {
    window.localStorage.setItem(
      STORAGE_KEYS.literatureCache,
      JSON.stringify({ version: 1, data: { entries: [{ nonsense: true }] } }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(readCache(cacheKey('cats', ['pubmed'], null, 50))).resolves.toBeNull();
    warnSpy.mockRestore();
  });

  it('completely malformed JSON yields a miss rather than a crash', async () => {
    window.localStorage.setItem(STORAGE_KEYS.literatureCache, 'not json{');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(readCache(cacheKey('cats', ['pubmed'], null, 50))).resolves.toBeNull();
    warnSpy.mockRestore();
  });
});

describe('listEntries', () => {
  it('is empty when nothing is cached', async () => {
    await expect(listEntries()).resolves.toEqual([]);
  });

  it('lists cached searches newest-first, with the fields a "recent searches" UI needs', async () => {
    vi.useFakeTimers();
    try {
      await writeCache(
        cacheKey('cats', ['pubmed'], null, 50),
        entryPayload('a', { query: 'cats', sources: ['pubmed'], fromYear: null }),
      );
      vi.advanceTimersByTime(1000);
      await writeCache(
        cacheKey('dogs', ['pubmed', 'openalex'], 2020, 20),
        entryPayload('b', {
          query: 'dogs',
          sources: ['pubmed', 'openalex'],
          fromYear: 2020,
          resultsPerSource: 20,
        }),
      );

      const entries = await listEntries();
      expect(entries.map((entry) => entry.query)).toEqual(['dogs', 'cats']);
      expect(entries[0]?.sources).toEqual(['pubmed', 'openalex']);
      expect(entries[0]?.fromYear).toBe(2020);
      expect(entries[0]?.resultsPerSource).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes expired entries rather than listing them', async () => {
    vi.useFakeTimers();
    try {
      await writeCache(cacheKey('cats', ['pubmed'], null, 50), entryPayload('a'));
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      await writeCache(
        cacheKey('dogs', ['pubmed'], null, 50),
        entryPayload('b', { query: 'dogs' }),
      );

      const entries = await listEntries();
      expect(entries.map((entry) => entry.query)).toEqual(['dogs']);

      // Pruned from storage, not just filtered on the way out.
      const raw = window.localStorage.getItem(STORAGE_KEYS.literatureCache) ?? '';
      const stored = JSON.parse(raw) as { data: { entries: { query: string }[] } };
      expect(stored.data.entries.map((entry) => entry.query)).toEqual(['dogs']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clearCache', () => {
  it('removes the storage key outright, not a tombstone', async () => {
    const key = cacheKey('cats', ['pubmed'], null, 50);
    await writeCache(key, entryPayload('a'));
    expect(window.localStorage.getItem(STORAGE_KEYS.literatureCache)).not.toBeNull();

    await clearCache();

    expect(window.localStorage.getItem(STORAGE_KEYS.literatureCache)).toBeNull();
    expect(await readCache(key)).toBeNull();
  });
});
