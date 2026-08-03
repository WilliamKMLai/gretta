/** Ollama auto-detection: fall back to the Mac proxy without asking. */
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_URL, MAC_PROXY_URL, findOllama } from './autoDetect';

describe('findOllama', () => {
  it('keeps a configured URL that answers', async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    expect(await findOllama(DIRECT_URL, probe)).toEqual({ url: DIRECT_URL, changed: false });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Mac proxy when the direct address fails', async () => {
    // The whole point: the user should not have to read the README to learn
    // that WKWebView will not call http://localhost from an HTTPS page.
    const probe = vi.fn((url: string) => Promise.resolve(url === MAC_PROXY_URL));
    expect(await findOllama(DIRECT_URL, probe)).toEqual({ url: MAC_PROXY_URL, changed: true });
  });

  it('reports nothing found when neither answers', async () => {
    const probe = vi.fn(() => Promise.resolve(false));
    expect(await findOllama(DIRECT_URL, probe)).toEqual({ url: null, changed: false });
  });

  it('does not probe the proxy twice when it is already configured', async () => {
    const probe = vi.fn(() => Promise.resolve(false));
    await findOllama(MAC_PROXY_URL, probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('never redirects a custom remote URL to the proxy silently on success', async () => {
    // A deliberately remote Ollama that answers is left exactly as configured.
    const remote = 'http://192.168.1.50:11434';
    const probe = vi.fn(() => Promise.resolve(true));
    expect(await findOllama(remote, probe)).toEqual({ url: remote, changed: false });
  });
});
