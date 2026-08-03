/**
 * In-memory OfficeService (ARCHITECTURE.md §7.1, §14) — same contract as the
 * Word-backed service, over a plain-text document with a cursor/selection
 * model. Powers unit tests, Playwright, and `pnpm dev:web`. Behavioral parity
 * notes are on each method (cursor placement, append newline, 1.4 gating) so
 * tests written against the mock stay honest about the real thing. Failures
 * always *reject* (never throw synchronously) — exactly like `Word.run`.
 */
import { OfficeError } from '../../types/errors';
import type {
  HighlightColor,
  HostInfo,
  OfficeService,
  OfficeThemeKind,
  SelectionInfo,
} from './office.types';
import { WORD_API_COMMENTS, isVersionAtLeast } from './requirements';

/** Seed document for browser dev mode — enough structure to exercise every op. */
export const SAMPLE_DOCUMENT_TEXT = [
  'GRETTA browser dev mode uses this in-memory document instead of a real Word file.',
  'Select part of this paragraph, then use the actions above to read or replace it.',
  'Appended text lands after this final paragraph.',
].join('\n');

export interface MockOfficeOptions {
  /** Initial document text; paragraphs separated by "\n". */
  initialText?: string;
  /** What ready() reports; defaults to a Word-like host so features enable. */
  hostInfo?: HostInfo;
  /** Highest supported version per requirement set. Default: WordApi 1.4. */
  supportedSets?: Record<string, string>;
  /** Initial selection offsets into the text (default: collapsed at 0). */
  selection?: { start: number; end: number };
}

export interface MockComment {
  text: string;
  /** Selection text the comment was anchored to. */
  anchor: string;
}

export interface MockHighlight {
  /** null records a "clear highlight" call. */
  color: Exclude<HighlightColor, 'none'> | null;
  /** Selection text the highlight applied to. */
  anchor: string;
}

export interface MockOfficeState {
  text: string;
  selection: { start: number; end: number; text: string };
  comments: MockComment[];
  highlights: MockHighlight[];
}

export class MockOfficeService implements OfficeService {
  private text: string;
  private selStart: number;
  private selEnd: number;
  private readonly hostInfo: HostInfo;
  private readonly supportedSets: Record<string, string>;
  private readonly comments: MockComment[] = [];
  private readonly highlights: MockHighlight[] = [];
  private pendingFailure: OfficeError | null = null;

  constructor(options: MockOfficeOptions = {}) {
    this.text = options.initialText ?? SAMPLE_DOCUMENT_TEXT;
    this.hostInfo = options.hostInfo ?? {
      available: true,
      host: 'Word',
      platform: 'unknown',
    };
    this.supportedSets = options.supportedSets ?? { WordApi: '1.4' };
    const selection = options.selection ?? { start: 0, end: 0 };
    this.selStart = this.clamp(selection.start);
    this.selEnd = this.clamp(Math.max(selection.start, selection.end));
  }

  ready(): Promise<HostInfo> {
    return Promise.resolve(this.hostInfo);
  }

  isApiSupported(set: 'WordApi', version: string): boolean {
    const supported = this.supportedSets[set];
    return supported !== undefined && isVersionAtLeast(supported, version);
  }

  /** Browser dev mode has no host theme; useTheme falls back to system. */
  getOfficeTheme(): OfficeThemeKind | null {
    return null;
  }

  /** In-memory stand-in for the document settings part. */
  private readonly documentSettings = new Map<string, string>();

  getDocumentSetting(key: string): Promise<string | null> {
    return Promise.resolve(this.documentSettings.get(key) ?? null);
  }

  setDocumentSetting(key: string, value: string | null): Promise<void> {
    if (value === null) this.documentSettings.delete(key);
    else this.documentSettings.set(key, value);
    return Promise.resolve();
  }

  getSelection(): Promise<SelectionInfo> {
    const text = this.selectionText();
    return this.takeFailure() ?? Promise.resolve({ text, isEmpty: text.trim().length === 0 });
  }

  /** Paragraphs the selection touches, joined with "\n" — mirrors the real service. */
  getParagraph(): Promise<string> {
    const touched = this.paragraphBounds().filter(
      (p) => this.selStart <= p.end && this.selEnd >= p.start,
    );
    return this.takeFailure() ?? Promise.resolve(touched.map((p) => p.text).join('\n'));
  }

  getDocument(): Promise<string> {
    return this.takeFailure() ?? Promise.resolve(this.text);
  }

  /** Cursor lands after the inserted text — parity with `select('End')`. */
  replaceSelection(text: string): Promise<void> {
    const failure = this.takeFailure();
    if (failure) return failure;
    this.text = this.text.slice(0, this.selStart) + text + this.text.slice(this.selEnd);
    this.selStart = this.selEnd = this.selStart + text.length;
    return Promise.resolve();
  }

  /** Inserts after the selection; cursor lands after the inserted text. */
  insertAtCursor(text: string): Promise<void> {
    const failure = this.takeFailure();
    if (failure) return failure;
    this.text = this.text.slice(0, this.selEnd) + text + this.text.slice(this.selEnd);
    this.selStart = this.selEnd = this.selEnd + text.length;
    return Promise.resolve();
  }

  /** Parity with the real service: a separating newline precedes the text. */
  appendText(text: string): Promise<void> {
    const failure = this.takeFailure();
    if (failure) return failure;
    this.text = `${this.text}\n${text}`;
    return Promise.resolve();
  }

  /** Gated exactly like the real service (WordApi 1.4). */
  createComment(text: string): Promise<void> {
    if (!this.isApiSupported('WordApi', WORD_API_COMMENTS)) {
      return Promise.reject(
        new OfficeError(
          'api-unsupported',
          `Comments need Word API ${WORD_API_COMMENTS}, which this Word version doesn't support.`,
          { code: `WordApi<${WORD_API_COMMENTS}` },
        ),
      );
    }
    const failure = this.takeFailure();
    if (failure) return failure;
    this.comments.push({ text, anchor: this.selectionText() });
    return Promise.resolve();
  }

  highlightSelection(color: HighlightColor = 'yellow'): Promise<void> {
    const failure = this.takeFailure();
    if (failure) return failure;
    this.highlights.push({
      color: color === 'none' ? null : color,
      anchor: this.selectionText(),
    });
    return Promise.resolve();
  }

  // ---- test & dev-harness helpers (not part of OfficeService) ----

  /** Immutable snapshot of the document, selection, comments, and highlights. */
  getState(): MockOfficeState {
    return {
      text: this.text,
      selection: { start: this.selStart, end: this.selEnd, text: this.selectionText() },
      comments: [...this.comments],
      highlights: [...this.highlights],
    };
  }

  setSelection(start: number, end: number): void {
    this.selStart = this.clamp(Math.min(start, end));
    this.selEnd = this.clamp(Math.max(start, end));
  }

  /** Selects the first occurrence of `snippet`; throws if absent (test bug). */
  selectText(snippet: string): void {
    const index = this.text.indexOf(snippet);
    if (index === -1) {
      throw new Error(`MockOfficeService.selectText: "${snippet}" not found in document`);
    }
    this.setSelection(index, index + snippet.length);
  }

  /** Makes the next operation reject — for exercising error paths in the UI. */
  failNextOperation(error?: OfficeError): void {
    this.pendingFailure =
      error ?? new OfficeError('office-failed', 'Mock failure requested by test.');
  }

  /** Pops the queued failure as a rejection, or null when none is queued. */
  private takeFailure(): Promise<never> | null {
    if (this.pendingFailure === null) return null;
    const failure = this.pendingFailure;
    this.pendingFailure = null;
    return Promise.reject(failure);
  }

  private selectionText(): string {
    return this.text.slice(this.selStart, this.selEnd);
  }

  private clamp(offset: number): number {
    return Math.min(Math.max(offset, 0), this.text.length);
  }

  private paragraphBounds(): { start: number; end: number; text: string }[] {
    const bounds: { start: number; end: number; text: string }[] = [];
    let offset = 0;
    for (const paragraph of this.text.split('\n')) {
      bounds.push({ start: offset, end: offset + paragraph.length, text: paragraph });
      offset += paragraph.length + 1; // skip the "\n"
    }
    return bounds;
  }
}
