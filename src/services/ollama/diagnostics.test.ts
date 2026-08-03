import type { HttpTransport } from './client.types';
import { diagnoseConnection } from './diagnostics';

const BASE = 'http://127.0.0.1:11434';

function versionTransport(handler: HttpTransport): HttpTransport {
  return handler;
}

describe('diagnoseConnection', () => {
  it('reports ok with version and latency when /api/version answers', async () => {
    const transport = versionTransport(() =>
      Promise.resolve(new Response('{"version":"0.9.9"}', { status: 200 })),
    );
    const result = await diagnoseConnection({ baseUrl: BASE, platform: 'PC', transport });
    expect(result).toMatchObject({ status: 'ok', version: '0.9.9' });
  });

  it('reports http-error with the status code', async () => {
    const transport = versionTransport(() =>
      Promise.resolve(new Response('nope', { status: 500 })),
    );
    await expect(diagnoseConnection({ baseUrl: BASE, platform: 'PC', transport })).resolves.toEqual(
      { status: 'http-error', httpStatus: 500 },
    );
  });

  it('reports invalid-response for non-Ollama JSON', async () => {
    const transport = versionTransport(() =>
      Promise.resolve(new Response('{"hello":"world"}', { status: 200 })),
    );
    const result = await diagnoseConnection({ baseUrl: BASE, platform: 'PC', transport });
    expect(result.status).toBe('invalid-response');
  });

  it('reports offline when nothing answers even the opaque ping', async () => {
    const transport = versionTransport(() => Promise.reject(new TypeError('fetch failed')));
    const result = await diagnoseConnection({ baseUrl: BASE, platform: 'Mac', transport });
    expect(result.status).toBe('offline');
  });

  it('discriminates blocked: cors elsewhere, mixed-content on Mac + http://', async () => {
    const transport: HttpTransport = (_url, init) =>
      init.mode === 'no-cors'
        ? Promise.resolve(new Response(null, { status: 200 }))
        : Promise.reject(new TypeError('blocked'));

    await expect(
      diagnoseConnection({ baseUrl: BASE, platform: 'PC', transport }),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'cors' });

    await expect(
      diagnoseConnection({ baseUrl: BASE, platform: 'Mac', transport }),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'mixed-content' });

    await expect(
      diagnoseConnection({ baseUrl: 'https://localhost:11435', platform: 'Mac', transport }),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'cors' });
  });
});
