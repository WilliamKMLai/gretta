/**
 * Native folder dialog, opened by the companion (DECISIONS.md ADR-033).
 *
 * The Word task pane cannot do this: Office.js has no directory picker,
 * `showDirectoryPicker()` is Chromium-only so it is absent under WKWebView on
 * macOS, and even where it exists it yields a `FileSystemDirectoryHandle`
 * rather than the absolute path this companion needs to `readdir`. The
 * companion is a local process with a desktop session, so it can.
 *
 * Kept out of `server.mts` deliberately — that file is at its size limit, and
 * this is the one place in the project that spawns a child process, which is
 * worth being able to read on its own.
 *
 * Two invariants, both asserted in tests rather than left to review:
 *
 * 1. **Nothing from the request reaches a command line.** The endpoint takes no
 *    body, `execFile` is used with an argument array (never `exec` with an
 *    interpolated string), and the prompt text is a constant in this file.
 * 2. **Only one dialog at a time.** Two native modal windows competing for one
 *    desktop session is a state with no good exit, so a second request is
 *    refused rather than served.
 */
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import type { PickFolderResult } from '../../src/types/knowledgebase';

const run = promisify(execFile);

/**
 * A constant, and it must stay one. It is interpolated into the AppleScript and
 * PowerShell source below, so anything reaching it from a request body would be
 * script injection.
 */
const PROMPT = 'Choose a folder for your GRETTA knowledge base';

/**
 * Two minutes. Long enough to browse a network volume, short enough that a
 * dialog someone opened and walked away from cannot wedge the request forever.
 * `execFile`'s own timeout kills the child, so no orphan window is left behind.
 */
const TIMEOUT_MS = 120_000;

/**
 * `POSIX path of` yields a trailing slash (`/Users/you/Docs/`). Stripped so a
 * picked path is byte-identical to the same path typed by hand — otherwise the
 * same folder can appear twice in a collection's list and look like two.
 */
const APPLESCRIPT = `POSIX path of (choose folder with prompt "${PROMPT}")`;

/**
 * Prints the selected path, or nothing at all when the user cancels, and always
 * exits 0. Deliberately not signalling cancellation through an exit code: a
 * genuine PowerShell failure is also a non-zero exit, and the two must not be
 * confused — a cancel is not an error. Empty stdout is the cancel signal.
 *
 * `-STA` is required; `FolderBrowserDialog` is a single-threaded-apartment COM
 * control and silently fails to appear without it.
 */
const POWERSHELL = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
  `$dialog.Description = '${PROMPT}';`,
  '$dialog.ShowNewFolderButton = $false;',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
].join(' ');

/** Whether this platform has a dialog at all. Reported on `/health`. */
export function isPickFolderSupported(platform: string = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** Trailing-slash normalization, guarding the root so `/` does not become ``. */
function normalize(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.replace(/\/+$/u, '') : trimmed;
}

/**
 * Whether an `osascript` failure was the user pressing Cancel.
 *
 * AppleScript reports it as error -128 ("User canceled."), which arrives as a
 * non-zero exit with that text on stderr — indistinguishable from a real
 * failure by exit code alone, hence matching on the message. The spelling
 * varies by locale and by macOS version, so both spellings and the numeric code
 * are accepted; a miss costs a spurious error banner, not a wrong path.
 */
function isAppleScriptCancel(stderr: string): boolean {
  return /-128|user cancell?ed/iu.test(stderr);
}

/** Set while a dialog is open; the concurrency guard. */
let dialogOpen = false;

async function pickOnMacOS(): Promise<PickFolderResult> {
  try {
    const { stdout } = await run('osascript', ['-e', APPLESCRIPT], { timeout: TIMEOUT_MS });
    const path = normalize(stdout);
    // An empty path with a zero exit should not happen, but treating it as a
    // success would hand the indexer "" and bind the whole filesystem.
    return path === '' ? { ok: false, reason: 'cancelled' } : { ok: true, path };
  } catch (error) {
    const stderr = stderrOf(error);
    if (isAppleScriptCancel(stderr)) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'failed', message: describe(error, stderr) };
  }
}

async function pickOnWindows(): Promise<PickFolderResult> {
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', POWERSHELL], {
      timeout: TIMEOUT_MS,
    });
    const path = stdout.trim();
    return path === '' ? { ok: false, reason: 'cancelled' } : { ok: true, path };
  } catch (error) {
    return { ok: false, reason: 'failed', message: describe(error, stderrOf(error)) };
  }
}

/**
 * `execFile` attaches captured output to the rejection. Typed narrowly here
 * because Node's own error type does not carry it, and `String(unknown)` on the
 * raw property would happily stringify an object to `[object Object]`.
 */
function stderrOf(error: unknown): string {
  const captured = (error as { stderr?: unknown }).stderr;
  if (typeof captured === 'string') return captured;
  return Buffer.isBuffer(captured) ? captured.toString('utf8') : '';
}

/** A message worth showing next to "could not open the folder picker". */
function describe(error: unknown, stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed !== '') return trimmed.split('\n')[0] ?? trimmed;
  if ((error as { killed?: unknown }).killed === true) return 'The dialog timed out.';
  return error instanceof Error ? error.message : 'The folder picker failed.';
}

/**
 * Opens a native folder dialog and resolves with what the user did.
 *
 * Never throws: every outcome — including "this platform has none" and "one is
 * already open" — is a value, because the caller is an HTTP route and a
 * cancelled dialog is not a 500.
 */
export async function pickFolder(platform: string = process.platform): Promise<PickFolderResult> {
  if (!isPickFolderSupported(platform)) return { ok: false, reason: 'unsupported' };
  if (dialogOpen) return { ok: false, reason: 'busy' };

  dialogOpen = true;
  try {
    return platform === 'darwin' ? await pickOnMacOS() : await pickOnWindows();
  } finally {
    dialogOpen = false;
  }
}
