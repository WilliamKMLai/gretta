/**
 * Word-backed OfficeService (ARCHITECTURE.md §7.1) — the only file that calls
 * the Word JavaScript API. Every operation:
 *  - runs inside a single `Word.run` batch with explicit `load()`/`sync()`;
 *  - inserts text via `insertText` exclusively — never `insertHtml` (ADR-007);
 *  - normalizes every failure into a typed `OfficeError` (§12.1) — raw
 *    `OfficeExtension.Error`s never escape this file.
 *
 * Requirement sets: every member used here is WordApi 1.1 except
 * `Range.insertComment` (1.4, runtime-gated); the manifest floor is 1.3 for
 * the table-paragraphs reason documented in ./requirements.ts.
 */
import { OfficeError, toAppError } from '../../types/errors';
import type {
  HighlightColor,
  HostInfo,
  OfficeService,
  OfficeThemeKind,
  SelectionInfo,
} from './office.types';
import { WORD_API_COMMENTS } from './requirements';

/** Word's classic highlighter palette for our semantic colors. */
const HIGHLIGHT_HEX: Record<Exclude<HighlightColor, 'none'>, string> = {
  yellow: '#FFFF00',
  green: '#00FF00',
  pink: '#FF00FF',
};

/**
 * office.js clears a highlight when `font.highlightColor` is set to null
 * (documented behavior), but the typings declare the property as `string` —
 * hence this single, contained assertion.
 */
const CLEAR_HIGHLIGHT = null as unknown as string;

function isOfficeExtensionErrorLike(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

function wrapOfficeFailure(operation: string, cause: unknown): OfficeError {
  if (isOfficeExtensionErrorLike(cause)) {
    return new OfficeError(
      'office-failed',
      `Word couldn't complete "${operation}" (${cause.code}). ${cause.message}`,
      { code: cause.code, cause },
    );
  }
  return new OfficeError('office-failed', `Word couldn't complete "${operation}".`, { cause });
}

export class WordOfficeService implements OfficeService {
  private readonly hostInfo: HostInfo;

  constructor(hostInfo: HostInfo) {
    this.hostInfo = hostInfo;
  }

  ready(): Promise<HostInfo> {
    return Promise.resolve(this.hostInfo);
  }

  isApiSupported(set: 'WordApi', version: string): boolean {
    try {
      return Office.context.requirements.isSetSupported(set, version);
    } catch {
      return false;
    }
  }

  async getSelection(): Promise<SelectionInfo> {
    return this.run('read the selection', async (context) => {
      const range = context.document.getSelection();
      range.load('text');
      await context.sync();
      return { text: range.text, isEmpty: range.text.trim().length === 0 };
    });
  }

  /**
   * Text of every paragraph the selection touches (one paragraph when the
   * cursor is collapsed), joined with newlines.
   */
  async getParagraph(): Promise<string> {
    return this.run('read the current paragraph', async (context) => {
      const paragraphs = context.document.getSelection().paragraphs;
      paragraphs.load('text');
      await context.sync();
      return paragraphs.items.map((paragraph) => paragraph.text).join('\n');
    });
  }

  async getDocument(): Promise<string> {
    return this.run('read the document', async (context) => {
      const body = context.document.body;
      body.load('text');
      await context.sync();
      return body.text;
    });
  }

  /** Replaces the selection; leaves the cursor after the inserted text. */
  async replaceSelection(text: string): Promise<void> {
    await this.run('replace the selection', async (context) => {
      const inserted = context.document.getSelection().insertText(text, 'Replace');
      inserted.select('End');
      await context.sync();
    });
  }

  /**
   * Inserts at the cursor (after the selection when one exists) and leaves
   * the cursor after the inserted text.
   */
  async insertAtCursor(text: string): Promise<void> {
    await this.run('insert at the cursor', async (context) => {
      const inserted = context.document.getSelection().insertText(text, 'End');
      inserted.select('End');
      await context.sync();
    });
  }

  /**
   * Appends to the end of the document as new paragraph content. Word turns
   * embedded newlines into paragraph breaks; the leading newline separates
   * the appended text from existing content (on an empty document this
   * leaves one leading empty paragraph — accepted, and noted in the Phase 3
   * real-Word checklist). The viewport is deliberately not scrolled.
   */
  async appendText(text: string): Promise<void> {
    await this.run('append to the document', async (context) => {
      context.document.body.insertText(`\n${text}`, 'End');
      await context.sync();
    });
  }

  /** Requires WordApi 1.4 — checked up front so the failure is instant and clear. */
  async createComment(text: string): Promise<void> {
    if (!this.isApiSupported('WordApi', WORD_API_COMMENTS)) {
      throw new OfficeError(
        'api-unsupported',
        `Comments need Word API ${WORD_API_COMMENTS}, which this Word version doesn't support.`,
        { code: `WordApi<${WORD_API_COMMENTS}` },
      );
    }
    await this.run('add a comment', async (context) => {
      context.document.getSelection().insertComment(text);
      await context.sync();
    });
  }

  async highlightSelection(color: HighlightColor = 'yellow'): Promise<void> {
    await this.run('highlight the selection', async (context) => {
      const font = context.document.getSelection().font;
      font.highlightColor = color === 'none' ? CLEAR_HIGHLIGHT : HIGHLIGHT_HEX[color];
      await context.sync();
    });
  }

  getOfficeTheme(): OfficeThemeKind | null {
    if (!this.hostInfo.available) return null;
    try {
      const context = Office.context as {
        officeTheme?: { isDarkTheme?: boolean; bodyBackgroundColor?: string };
      };
      const theme = context.officeTheme;
      if (theme === undefined) return null;
      if (typeof theme.isDarkTheme === 'boolean') return theme.isDarkTheme ? 'dark' : 'light';
      const luminance = hexLuminance(theme.bodyBackgroundColor);
      if (luminance === null) return null;
      return luminance < 0.5 ? 'dark' : 'light';
    } catch {
      return null;
    }
  }

  getDocumentSetting(key: string): Promise<string | null> {
    if (!this.hostInfo.available) return Promise.resolve(null);
    try {
      const value: unknown = Office.context.document.settings.get(key);
      return Promise.resolve(typeof value === 'string' ? value : null);
    } catch {
      return Promise.resolve(null);
    }
  }

  async setDocumentSetting(key: string, value: string | null): Promise<void> {
    if (!this.hostInfo.available) return;
    const settings = Office.context.document.settings;
    if (value === null) settings.remove(key);
    else settings.set(key, value);
    // saveAsync persists into the document part; without it the value is lost
    // on close. Failures are non-fatal: the binding simply won't persist.
    await new Promise<void>((resolve) => {
      try {
        settings.saveAsync(() => {
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  private ensureHost(operation: string): void {
    if (!this.hostInfo.available) {
      throw new OfficeError(
        'host-unavailable',
        `Can't ${operation} — GRETTA isn't running inside Word.`,
      );
    }
  }

  private async run<T>(
    operation: string,
    batch: (context: Word.RequestContext) => Promise<T>,
  ): Promise<T> {
    this.ensureHost(operation);
    try {
      return await Word.run(batch);
    } catch (error) {
      throw toAppError(error, (cause) => wrapOfficeFailure(operation, cause));
    }
  }
}

/** Perceived luminance (0–1) of a `#rrggbb` color; `null` when unparsable. */
export function hexLuminance(hex: string | undefined): number | null {
  if (hex === undefined) return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return null;
  const value = match[1] ?? '';
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
