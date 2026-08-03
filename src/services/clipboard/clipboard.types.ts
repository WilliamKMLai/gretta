/**
 * Clipboard boundary contract (ARCHITECTURE.md §7.4, ADR-012).
 *
 * Kept separate from OfficeService because the clipboard is a web-platform
 * capability, not a Word API. The Phase 3 implementation tries the async
 * Clipboard API first and falls back to a hidden-textarea `execCommand('copy')`
 * for the older webviews some Office hosts embed. Failures surface as typed
 * errors so the UI can tell the user to copy manually.
 */
export interface ClipboardService {
  /** Copies plain text to the system clipboard. */
  copy(text: string): Promise<void>;
}
