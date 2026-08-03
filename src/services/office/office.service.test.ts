/**
 * WordOfficeService integration tests (ARCHITECTURE.md §14).
 *
 * Two mocking strategies, deliberately:
 *  - `office-addin-mock` (Microsoft's harness) for load/sync plumbing on the
 *    read paths — proves our batches work against their emulation;
 *  - hand-rolled `Word.run` fakes where we assert call *ordering* and error
 *    shapes, which the harness doesn't track.
 * Nothing here touches a real Word host; that's the Phase 3 manual checklist.
 */
import { OfficeMockObject } from 'office-addin-mock';
import { OfficeError } from '../../types/errors';
import { WordOfficeService } from './office.service';
import type { HostInfo } from './office.types';

const WORD_HOST: HostInfo = { available: true, host: 'Word', platform: 'PC' };
const globals = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  saved.Word = globals.Word;
  saved.Office = globals.Office;
  // Default Office stub: every requirement set supported.
  globals.Office = {
    context: { requirements: { isSetSupported: () => true } },
  };
});

afterEach(() => {
  globals.Word = saved.Word;
  globals.Office = saved.Office;
});

function service(): WordOfficeService {
  return new WordOfficeService(WORD_HOST);
}

describe('WordOfficeService · office-addin-mock read paths', () => {
  it('getDocument loads and returns the body text', async () => {
    globals.Word = new OfficeMockObject({
      context: { document: { body: { text: 'Hello from the body.' } } },
      run: async function run(callback: (context: unknown) => Promise<unknown>) {
        return callback(this.context);
      },
    });
    await expect(service().getDocument()).resolves.toBe('Hello from the body.');
  });

  it('getSelection maps whitespace-only text to isEmpty', async () => {
    globals.Word = new OfficeMockObject({
      context: {
        document: {
          selection: { text: '   ' },
          getSelection: function getSelection() {
            return this.selection;
          },
        },
      },
      run: async function run(callback: (context: unknown) => Promise<unknown>) {
        return callback(this.context);
      },
    });
    await expect(service().getSelection()).resolves.toEqual({ text: '   ', isEmpty: true });
  });
});

describe('WordOfficeService · batching and ordering', () => {
  it('getParagraph joins every paragraph the selection touches', async () => {
    const paragraphs = {
      items: [{ text: 'Para one.' }, { text: 'Para two.' }],
      load: () => undefined,
    };
    const context = {
      document: { getSelection: () => ({ paragraphs }) },
      sync: () => Promise.resolve(),
    };
    globals.Word = { run: (cb: (c: typeof context) => Promise<unknown>) => cb(context) };
    await expect(service().getParagraph()).resolves.toBe('Para one.\nPara two.');
  });

  it('replaceSelection inserts with Replace, parks the cursor, then syncs — in that order', async () => {
    const calls: string[] = [];
    const inserted = {
      select: (mode: string) => {
        calls.push(`select:${mode}`);
      },
    };
    const context = {
      document: {
        getSelection: () => ({
          insertText: (text: string, location: string) => {
            calls.push(`insertText:${location}:${text}`);
            return inserted;
          },
        }),
      },
      sync: () => {
        calls.push('sync');
        return Promise.resolve();
      },
    };
    globals.Word = { run: (cb: (c: typeof context) => Promise<unknown>) => cb(context) };
    await service().replaceSelection('new text');
    expect(calls).toEqual(['insertText:Replace:new text', 'select:End', 'sync']);
  });

  it('appendText prefixes a separating newline and targets the body End', async () => {
    const calls: string[] = [];
    const context = {
      document: {
        body: {
          insertText: (text: string, location: string) => {
            calls.push(`body.insertText:${location}:${JSON.stringify(text)}`);
          },
        },
      },
      sync: () => Promise.resolve(),
    };
    globals.Word = { run: (cb: (c: typeof context) => Promise<unknown>) => cb(context) };
    await service().appendText('appended');
    expect(calls).toEqual(['body.insertText:End:"\\nappended"']);
  });
});

describe('WordOfficeService · failure normalization and gating', () => {
  it('normalizes OfficeExtension-shaped rejections into OfficeError with the code preserved', async () => {
    globals.Word = {
      run: () => Promise.reject(Object.assign(new Error('boom'), { code: 'GeneralException' })),
    };
    const failure = await service()
      .getDocument()
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OfficeError);
    const officeError = failure as OfficeError;
    expect(officeError.kind).toBe('office-failed');
    expect(officeError.code).toBe('GeneralException');
    expect(officeError.message).toContain('read the document');
  });

  it('createComment fails fast with api-unsupported and never enters Word.run', async () => {
    globals.Office = {
      context: { requirements: { isSetSupported: () => false } },
    };
    const run = vi.fn();
    globals.Word = { run };
    const failure = await service()
      .createComment('note')
      .catch((e: unknown) => e);
    expect((failure as OfficeError).kind).toBe('api-unsupported');
    expect(run).not.toHaveBeenCalled();
  });

  it('throws host-unavailable outside Word without touching Word.run', async () => {
    const run = vi.fn();
    globals.Word = { run };
    const browser = new WordOfficeService({
      available: false,
      host: 'unknown',
      platform: 'unknown',
    });
    const failure = await browser.getSelection().catch((e: unknown) => e);
    expect((failure as OfficeError).kind).toBe('host-unavailable');
    expect(run).not.toHaveBeenCalled();
  });
});
