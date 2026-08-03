/* eslint-disable @typescript-eslint/no-deprecated --
   This suite deliberately exercises the deprecated execCommand fallback path
   (ADR-012); the production call site carries its own scoped disable. */
import { createClipboardService } from './clipboard.service';

// jsdom doesn't implement execCommand, so treat it as optional: bind the
// original when present, and after each test either restore it or delete our
// stub so the document is back to pristine.
const documentWithOptionalExec = document as { execCommand?: typeof document.execCommand };
const originalExecCommand = documentWithOptionalExec.execCommand?.bind(document);

function stubAsyncClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  if (originalExecCommand === undefined) {
    delete documentWithOptionalExec.execCommand;
  } else {
    document.execCommand = originalExecCommand;
  }
});

describe('createClipboardService', () => {
  it('uses the async Clipboard API when it works', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubAsyncClipboard(writeText);
    const exec = vi.fn(() => true);
    document.execCommand = exec;

    await createClipboardService().copy('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when the async API rejects, and cleans up', async () => {
    stubAsyncClipboard(() => Promise.reject(new Error('denied')));
    const exec = vi.fn(() => true);
    document.execCommand = exec;

    await createClipboardService().copy('fallback text');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('throws one friendly error when both paths fail', async () => {
    stubAsyncClipboard(() => Promise.reject(new Error('denied')));
    document.execCommand = vi.fn(() => false);

    await expect(createClipboardService().copy('x')).rejects.toThrow(/copy manually/i);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
