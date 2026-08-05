/**
 * Folder-picker tests (DECISIONS.md ADR-033).
 *
 * The dialog itself is a modal window awaiting a human and cannot be tested —
 * it is verified by hand on each platform. Everything around it can be, and
 * two of these are security assertions rather than behaviour ones: that the
 * argument-array form of `execFile` is used, and that nothing request-derived
 * reaches it. This is the only place in the project that spawns a process.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { isPickFolderSupported, pickFolder } from './pick-folder.mts';

/*
 * The real `execFile` carries a `util.promisify.custom` that resolves
 * `{ stdout, stderr }` and attaches both to the error on rejection. A bare
 * `vi.fn()` does not, and generic promisify would then hand back `stdout`
 * alone — so the production `const { stdout } = await run(...)` would
 * destructure a string and silently yield undefined. Reproducing the custom
 * here is what makes this mock a stand-in rather than a different function.
 *
 * `default` is included because the module namespace is imported elsewhere in
 * this graph; omitting it makes the mock unloadable.
 */
vi.mock('node:child_process', async () => {
  const { promisify: promisifyFn } = await import('node:util');
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, promisifyFn.custom, {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        (execFileMock as (...call: unknown[]) => void)(
          ...args,
          (error: (Error & { stdout?: string; stderr?: string }) | null, out = '', err = '') => {
            if (error === null) resolve({ stdout: out, stderr: err });
            else reject(Object.assign(error, { stdout: out, stderr: err }));
          },
        );
      }),
  });
  return { execFile: execFileMock, default: { execFile: execFileMock } };
});

const mockExecFile = vi.mocked(execFile);

/** The callback signature `promisify` drives: (error, stdout, stderr). */
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function resolvesWith(stdout: string, stderr = ''): void {
  mockExecFile.mockImplementation(((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: ExecCallback,
  ) => {
    callback(null, stdout, stderr);
  }) as unknown as typeof execFile);
}

function rejectsWith(error: Error & { stderr?: string; killed?: boolean }): void {
  mockExecFile.mockImplementation(((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: ExecCallback,
  ) => {
    callback(error, '', error.stderr ?? '');
  }) as unknown as typeof execFile);
}

/**
 * Holds the dialog open, and returns the release. The release is not optional:
 * an unsettled call leaves the module's concurrency guard set, which would make
 * every later test in this file report `busy`.
 */
function hangs(): () => void {
  let settle: ExecCallback | null = null;
  mockExecFile.mockImplementation(((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: ExecCallback,
  ) => {
    settle = callback;
  }) as unknown as typeof execFile);
  return () => settle?.(null, '/Users/you/Docs\n', '');
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('isPickFolderSupported', () => {
  it('is true only where a native dialog exists', () => {
    expect(isPickFolderSupported('darwin')).toBe(true);
    expect(isPickFolderSupported('win32')).toBe(true);
    expect(isPickFolderSupported('linux')).toBe(false);
    expect(isPickFolderSupported('freebsd')).toBe(false);
  });
});

describe('pickFolder', () => {
  it('reports unsupported without spawning anything', async () => {
    expect(await pickFolder('linux')).toEqual({ ok: false, reason: 'unsupported' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('runs osascript on macOS with an argument array, never a shell string', async () => {
    // The security assertion. `execFile` with an array never involves a shell,
    // so there is no quoting to get wrong; `exec` with an interpolated string
    // would be the injection surface this route must not have.
    resolvesWith('/Users/you/Documents/References/\n');
    await pickFolder('darwin');

    const [file, args] = mockExecFile.mock.calls[0] ?? [];
    expect(file).toBe('osascript');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['-e', expect.stringContaining('choose folder with prompt')]);
  });

  it('strips the trailing slash AppleScript adds, so a picked path matches a typed one', async () => {
    resolvesWith('/Users/you/Documents/References/\n');
    expect(await pickFolder('darwin')).toEqual({
      ok: true,
      path: '/Users/you/Documents/References',
    });
  });

  it('keeps the root path intact rather than stripping it to nothing', async () => {
    resolvesWith('/\n');
    expect(await pickFolder('darwin')).toEqual({ ok: true, path: '/' });
  });

  it('reads an AppleScript cancel as cancelled, not as a failure', async () => {
    // osascript exits non-zero on Cancel, so exit code alone cannot tell the
    // two apart — the -128 on stderr is what distinguishes them.
    rejectsWith(
      Object.assign(new Error('Command failed'), {
        stderr: 'execution error: User canceled. (-128)',
      }),
    );
    expect(await pickFolder('darwin')).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('accepts the other spelling of cancelled, which varies by locale and OS version', async () => {
    rejectsWith(Object.assign(new Error('Command failed'), { stderr: 'User cancelled.' }));
    expect(await pickFolder('darwin')).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('reports a genuine osascript failure as failed, with its first line', async () => {
    rejectsWith(
      Object.assign(new Error('Command failed'), {
        stderr: 'execution error: Not authorised to send Apple events\nmore detail',
      }),
    );
    expect(await pickFolder('darwin')).toEqual({
      ok: false,
      reason: 'failed',
      message: 'execution error: Not authorised to send Apple events',
    });
  });

  it('names a timeout rather than reporting an empty message', async () => {
    rejectsWith(Object.assign(new Error('Command failed'), { killed: true }));
    expect(await pickFolder('darwin')).toEqual({
      ok: false,
      reason: 'failed',
      message: 'The dialog timed out.',
    });
  });

  it('runs PowerShell with -STA on Windows, which the dialog needs to appear at all', async () => {
    resolvesWith('C:\\Users\\you\\Documents\\References\r\n');
    const result = await pickFolder('win32');

    const [file, args] = mockExecFile.mock.calls[0] ?? [];
    expect(file).toBe('powershell.exe');
    expect(args).toContain('-STA');
    expect(args).toContain('-NoProfile');
    expect(result).toEqual({ ok: true, path: 'C:\\Users\\you\\Documents\\References' });
  });

  it('reads empty PowerShell output as cancelled', async () => {
    // The Windows script always exits 0 and prints nothing on Cancel, so that
    // a real PowerShell failure stays distinguishable from a dismissed dialog.
    resolvesWith('\r\n');
    expect(await pickFolder('win32')).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('never treats an empty path as a success, on either platform', async () => {
    // "" would bind the entire filesystem to a collection.
    resolvesWith('   \n');
    expect(await pickFolder('darwin')).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('refuses a second dialog while one is open rather than opening two', async () => {
    const release = hangs();
    const first = pickFolder('darwin');

    expect(await pickFolder('darwin')).toEqual({ ok: false, reason: 'busy' });
    // One spawn, not two: two native modal windows on one desktop session is a
    // state with no good exit.
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toEqual({ ok: true, path: '/Users/you/Docs' });
  });

  it('releases the guard after a failure, so one error does not wedge the picker', async () => {
    rejectsWith(Object.assign(new Error('Command failed'), { stderr: 'boom' }));
    await pickFolder('darwin');

    resolvesWith('/Users/you/Docs\n');
    expect(await pickFolder('darwin')).toEqual({ ok: true, path: '/Users/you/Docs' });
  });

  it('passes a timeout, so a forgotten dialog cannot wedge the request forever', async () => {
    resolvesWith('/Users/you/Docs\n');
    await pickFolder('darwin');

    const options = mockExecFile.mock.calls[0]?.[2] as { timeout?: number } | undefined;
    expect(options?.timeout).toBeGreaterThan(0);
  });
});
