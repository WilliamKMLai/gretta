/**
 * Office boundary contract (ARCHITECTURE.md §7.1).
 *
 * `services/office` is the ONLY place Office.js may be touched (rule zero,
 * enforced by lint). Phase 3 supplies the `Word.run`-backed implementation and
 * the in-memory mock; this file is the stable seam everything else compiles
 * against in the meantime.
 */
import type { HostPlatform } from '../../types/domain';

/** Simplified host theme classification (ADR-013b). */
export type OfficeThemeKind = 'light' | 'dark';

/** Where the app is running, resolved once at startup via `Office.onReady`. */
export interface HostInfo {
  /** True only when hosted inside Word with Office.js ready. */
  available: boolean;
  host: 'Word' | 'unknown';
  platform: HostPlatform;
}

/** Result of reading the current selection. */
export interface SelectionInfo {
  /** Selected text; empty string when the cursor is collapsed. */
  text: string;
  /** True when there is no usable selection (collapsed or whitespace-only). */
  isEmpty: boolean;
}

/** One image recovered from the selection, as base64 (ADR-035). */
export interface DocumentImage {
  /** Display name; the OOXML part name, e.g. `/word/media/image1.png`. */
  name: string;
  mediaType: string;
  /** Base64 payload, no data-URI prefix. */
  dataBase64: string;
}

/** Result of reading pictures out of the selection. */
export interface SelectedImages {
  images: DocumentImage[];
  /** Content types present that no browser can decode (EMF/WMF and friends). */
  undecodable: string[];
}

/**
 * Semantic highlight palette exposed to features; the Phase 3 implementation
 * maps these to concrete Word highlight color values. `none` clears highlighting.
 */
export type HighlightColor = 'yellow' | 'green' | 'pink' | 'none';

/**
 * Typed facade over the Word JavaScript API.
 *
 * Implementations must:
 *  - wrap every operation in `Word.run` with correct `load()`/`sync()` batching;
 *  - normalize all failures into typed `OfficeError`s (never leak
 *    `OfficeExtension.Error`);
 *  - insert text via `insertText` exclusively — never `insertHtml` (ADR-007);
 *  - gate APIs above the WordApi 1.3 manifest baseline with `isApiSupported`.
 */
export interface OfficeService {
  /** Resolves once the host is known; immediate in mock/browser mode. */
  ready(): Promise<HostInfo>;

  /** Runtime requirement-set check, e.g. `isApiSupported('WordApi', '1.4')`. */
  isApiSupported(set: 'WordApi', version: string): boolean;

  /** Reads the current selection. */
  getSelection(): Promise<SelectionInfo>;

  /**
   * Images inside the current selection, read as OOXML (ADR-035).
   *
   * The only non-text read in this contract. ADR-007's "never `insertHtml`"
   * rule is about *writing* markup into a document; nothing read here is ever
   * written back, and only image bytes are extracted.
   *
   * Returns an empty `images` array rather than throwing when the selection
   * holds no picture. `undecodable` is the case that needs saying out loud: a
   * pasted Excel chart or equation is stored as a Windows metafile, which no
   * browser can decode, so the user is looking at a figure GRETTA cannot read.
   */
  getSelectedImages(): Promise<SelectedImages>;

  /**
   * Inline pictures in the selection — the *cheap* read (ADR-035 amendment).
   *
   * `Range.inlinePictures` plus `getBase64ImageSrc()` are both WordApi 1.1 and
   * batch into an ordinary `Word.run`, where `getSelectedImages` pulls the whole
   * OOXML package (styles, numbering, theme) to find the same bytes. That cost
   * is fine for a button press and far too high to pay on every generation, so
   * this is what the automatic path uses.
   *
   * The trade is coverage: floating and text-wrapped figures are not inline
   * pictures and do not appear here. `Range.shapes` would catch them but is
   * `WordApiDesktop 1.2` — desktop-only, outside the requirement-set model — so
   * the thorough OOXML read behind the button stays the answer for those.
   */
  getSelectedInlinePictures(): Promise<DocumentImage[]>;

  /** Reads the full text of the paragraph containing the cursor. */
  getParagraph(): Promise<string>;

  /** Reads the full document body text. */
  getDocument(): Promise<string>;

  /** Replaces the current selection with plain text. */
  replaceSelection(text: string): Promise<void>;

  /** Inserts plain text at the cursor (after a selection, if any). */
  insertAtCursor(text: string): Promise<void>;

  /** Appends plain text to the end of the document body. */
  appendText(text: string): Promise<void>;

  /**
   * Attaches a comment to the current selection.
   * Requires WordApi 1.4; implementations throw a typed `api-unsupported`
   * `OfficeError` on older hosts so the UI can disable the action up front.
   */
  createComment(text: string): Promise<void>;

  /** Applies (or clears, with `none`) a highlight on the current selection. */
  highlightSelection(color?: HighlightColor): Promise<void>;

  /**
   * Current Word UI theme, for the `'office'` theme preference (ADR-013b).
   * `null` when unknown (browser dev mode, theme API absent) — callers fall
   * back to the system preference.
   */
  getOfficeTheme(): OfficeThemeKind | null;

  /**
   * Reads a document-scoped setting persisted INSIDE the .docx
   * (`Office.context.document.settings`). Used for the knowledge-base binding
   * (ADR-020) so the association travels with the file rather than living in
   * app state. Returns null when absent or unavailable (browser dev mode).
   */
  getDocumentSetting(key: string): Promise<string | null>;

  /** Writes and persists a document-scoped setting; no-ops outside Word. */
  setDocumentSetting(key: string, value: string | null): Promise<void>;
}
