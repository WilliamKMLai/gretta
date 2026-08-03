/**
 * Host detection (ARCHITECTURE.md §7.1). Resolves where the app is running —
 * inside Word (and on which platform) or in a plain browser — exactly once at
 * startup, before the first render.
 *
 * This is the first real slice of services/office; the full OfficeService
 * implementation (Phase 3) reuses it for `ready()`.
 */
import type { HostInfo } from './office.types';

/** How long to wait for `Office.onReady` before assuming no host will appear. */
const READY_TIMEOUT_MS = 4000;

function browserHost(): HostInfo {
  return { available: false, host: 'unknown', platform: 'unknown' };
}

function mapPlatform(platform: Office.PlatformType | null): HostInfo['platform'] {
  switch (platform) {
    case Office.PlatformType.PC:
      return 'PC';
    case Office.PlatformType.Mac:
      return 'Mac';
    case Office.PlatformType.OfficeOnline:
      return 'OfficeOnline';
    default:
      return 'unknown';
  }
}

/**
 * Detects the Office host, falling back to browser mode when:
 *  - `VITE_OFFICE_MOCK=1` (browser dev mode / E2E, set by `pnpm dev:web`);
 *  - office.js never loaded (CDN unreachable, plain-browser visit); or
 *  - `Office.onReady` does not settle within {@link READY_TIMEOUT_MS}.
 *
 * Never rejects — a task pane that cannot even start is the one failure mode
 * the error strategy (ARCHITECTURE.md §12) cannot explain to anyone.
 */
export async function detectHostInfo(timeoutMs: number = READY_TIMEOUT_MS): Promise<HostInfo> {
  if (import.meta.env.VITE_OFFICE_MOCK === '1') {
    return browserHost();
  }
  if (typeof Office === 'undefined' || typeof Office.onReady !== 'function') {
    return browserHost();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
  });

  try {
    const info = await Promise.race([Office.onReady(), timeout]);
    if (info === null) {
      return browserHost();
    }
    // Outside a real host, office.js resolves onReady with a null host; the
    // typings say non-null, so compare defensively rather than trusting them.
    const isWord = info.host === Office.HostType.Word;
    if (!isWord) {
      return browserHost();
    }
    return { available: true, host: 'Word', platform: mapPlatform(info.platform) };
  } finally {
    clearTimeout(timer);
  }
}
