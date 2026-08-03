/**
 * ClipboardService implementation (ARCHITECTURE.md §7.4, ADR-012).
 *
 * Tries the async Clipboard API first; some Office webviews expose it but
 * reject writes (permissions), so a hidden-textarea `execCommand('copy')`
 * fallback covers those. Both failing surfaces one friendly error the UI can
 * show next to the text so the user can copy manually.
 */
import type { ClipboardService } from './clipboard.types';

function execCommandFallback(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate legacy fallback for Office webviews that reject the async Clipboard API (ADR-012)
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function createClipboardService(): ClipboardService {
  return {
    async copy(text: string): Promise<void> {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // fall through to execCommand
      }
      if (!execCommandFallback(text)) {
        throw new Error('Copying to the clipboard failed — select the text and copy manually.');
      }
    },
  };
}
