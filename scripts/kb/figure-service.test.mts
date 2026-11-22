import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DescribeUnreachableError } from './describer.mts';
import type { FigureContext } from './figure-service.mts';
import { describeFigure, materializeFigure, sourceResolver } from './figure-service.mts';
import type { SqliteStore, StoredFigure } from './store.sqlite.mts';

function storedFigure(overrides: Partial<StoredFigure> = {}): StoredFigure {
  return {
    id: 'fig-1',
    collectionId: 'col-a',
    source: 'paper.pdf',
    contentHash: 'abc123',
    page: 1,
    bbox: JSON.stringify({ x0: 0, y0: 0, x1: 100, y1: 100 }),
    caption: 'Figure 1. Dose response.',
    description: null,
    mediaType: null,
    width: null,
    height: null,
    bytes: null,
    describedAt: null,
    ...overrides,
  };
}

function createFakeStore() {
  return {
    saveFigureImage: vi.fn(),
    saveFigureDescription: vi.fn(),
    updateChunkForFigure: vi.fn(),
  };
}

function asStore(fake: ReturnType<typeof createFakeStore>): SqliteStore {
  return fake as unknown as SqliteStore;
}

function createContext(overrides: Partial<FigureContext> = {}): FigureContext {
  return {
    collectionId: 'col-a',
    resolveSource: () => null,
    embedder: { model: 'fake-embed', embed: vi.fn(() => Promise.resolve([[0.5, 0.5]])) },
    describer: {
      model: 'fake-vision',
      describe: vi.fn(() => Promise.resolve('Plotted curve from 0 to 10 mM.')),
    },
    invalidate: vi.fn(),
    ...overrides,
  };
}

describe('sourceResolver', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('resolves files across all configured folders, preferring the first folder on overlap', () => {
    root = mkdtempSync(join(tmpdir(), 'kb-fig-src-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(first, 'shared.pdf'), 'first');
    writeFileSync(join(second, 'shared.pdf'), 'second');
    writeFileSync(join(second, 'only-second.pdf'), 'second');

    const resolveInFolders = sourceResolver([first, second]);
    expect(resolveInFolders('shared.pdf')).toBe(join(first, 'shared.pdf'));
    expect(resolveInFolders('only-second.pdf')).toBe(join(second, 'only-second.pdf'));
    expect(resolveInFolders('missing.pdf')).toBeNull();
  });

  it('rejects path traversal and sibling-prefix escapes even when the target exists', () => {
    root = mkdtempSync(join(tmpdir(), 'kb-fig-escape-'));
    const bound = join(root, 'refs');
    const sibling = join(root, 'refs-secret');
    mkdirSync(bound, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(root, 'outside.pdf'), 'secret');
    writeFileSync(join(sibling, 'leak.pdf'), 'secret');

    const resolveInFolders = sourceResolver([bound]);
    expect(resolveInFolders('../outside.pdf')).toBeNull();
    expect(resolveInFolders('../refs-secret/leak.pdf')).toBeNull();
    expect(resolveInFolders('')).toBeNull();
    expect(sourceResolver([])('paper.pdf')).toBeNull();
  });
});

describe('materializeFigure and describeFigure', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns already-cached bytes without touching disk or rewriting the store', async () => {
    const store = createFakeStore();
    const resolveSource = vi.fn(() => null);
    const cached = storedFigure({
      mediaType: 'image/png',
      bytes: Buffer.from('png-bytes'),
      width: 320,
      height: 240,
    });

    const context = createContext({ resolveSource });
    const result = await materializeFigure(asStore(store), context, cached);
    expect(result).toMatchObject({
      id: 'fig-1',
      mediaType: 'image/png',
      dataBase64: Buffer.from('png-bytes').toString('base64'),
      width: 320,
      height: 240,
    });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(store.saveFigureImage).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing ENOENT when a resolved PDF disappeared', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-fig-missing-'));
    const store = createFakeStore();
    const context = createContext({
      resolveSource: () => join(dir ?? '', 'vanished.pdf'),
    });

    await expect(materializeFigure(asStore(store), context, storedFigure())).resolves.toBeNull();
    expect(store.saveFigureImage).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the PDF on disk is corrupt', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-fig-corrupt-'));
    const badPdf = join(dir, 'corrupt.pdf');
    writeFileSync(badPdf, 'not a valid pdf');
    const store = createFakeStore();
    const context = createContext({ resolveSource: () => badPdf });

    await expect(materializeFigure(asStore(store), context, storedFigure())).resolves.toBeNull();
    expect(store.saveFigureImage).not.toHaveBeenCalled();
  }, 30_000);

  it('stores the description, re-embeds caption + description, and invalidates the query matrix', async () => {
    const store = createFakeStore();
    const invalidate = vi.fn();
    const context = createContext({ invalidate });

    const ok = await describeFigure(asStore(store), context, storedFigure(), 'base64data');
    expect(ok).toBe(true);
    expect(store.saveFigureDescription).toHaveBeenCalledWith(
      'fig-1',
      'Plotted curve from 0 to 10 mM.',
      expect.any(String),
    );
    expect(store.updateChunkForFigure).toHaveBeenCalledWith(
      'fig-1',
      'Figure 1. Dose response.\n\nPlotted curve from 0 to 10 mM.',
      [0.5, 0.5],
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('swallows unreachable describer failures without storing a partial description', async () => {
    const store = createFakeStore();
    const invalidate = vi.fn();
    const context = createContext({
      invalidate,
      describer: {
        model: 'fake-vision',
        describe: vi.fn(() => Promise.reject(new DescribeUnreachableError('offline'))),
      },
    });

    const figure = storedFigure();
    await expect(describeFigure(asStore(store), context, figure, 'b64')).resolves.toBe(false);
    expect(store.saveFigureDescription).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('skips writing description and vector when canCommit() rejects a stale run', async () => {
    const store = createFakeStore();
    const invalidate = vi.fn();
    const context = createContext({
      invalidate,
      canCommit: () => false,
    });

    const figure = storedFigure();
    await expect(describeFigure(asStore(store), context, figure, 'b64')).resolves.toBe(false);
    expect(store.saveFigureDescription).not.toHaveBeenCalled();
    expect(store.updateChunkForFigure).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('skips updating the chunk vector if the model changed while re-embedding', async () => {
    const store = createFakeStore();
    const invalidate = vi.fn();
    let checks = 0;
    const context = createContext({
      invalidate,
      canCommit: () => {
        checks += 1;
        return checks === 1;
      },
    });

    const figure = storedFigure();
    await expect(describeFigure(asStore(store), context, figure, 'b64')).resolves.toBe(false);
    expect(store.saveFigureDescription).toHaveBeenCalledTimes(1);
    expect(store.updateChunkForFigure).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
