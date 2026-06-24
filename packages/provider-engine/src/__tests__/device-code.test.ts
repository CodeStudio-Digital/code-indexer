import { describe, it, expect } from 'vitest';
import { startDeviceCodeFlow } from '../oauth/host/device-code.js';

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('startDeviceCodeFlow (generic RFC-8628 device flow)', () => {
  it('starts, then polls pending → slow_down (interval bumps) → authorized', async () => {
    let pollN = 0;
    const fetchMock = (async (url: RequestInfo | URL) => {
      if (String(url).includes('device_authorization')) {
        return res(200, {
          device_code: 'dc',
          user_code: 'UC-1',
          verification_uri: 'https://verify',
          verification_uri_complete: 'https://verify?code=UC-1',
          expires_in: 600,
          interval: 5,
        });
      }
      pollN++;
      if (pollN === 1) return res(400, { error: 'authorization_pending' });
      if (pollN === 2) return res(400, { error: 'slow_down' });
      return res(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'x', token_type: 'Bearer' });
    }) as unknown as typeof fetch;

    const flow = await startDeviceCodeFlow({
      deviceAuthUrl: 'https://host/device_authorization',
      tokenUrl: 'https://host/token',
      clientId: 'cid',
      fetch: fetchMock,
    });
    expect(flow.userCode).toBe('UC-1');
    expect(flow.verificationUri).toBe('https://verify');
    expect(flow.verificationUriComplete).toBe('https://verify?code=UC-1');
    expect(flow.interval).toBe(5);

    expect(await flow.poll()).toEqual({ status: 'pending' });
    expect(await flow.poll()).toEqual({ status: 'pending' });
    expect(flow.interval).toBe(10); // slow_down bumped the interval +5

    const done = await flow.poll();
    expect(done.status).toBe('authorized');
    expect(done.tokens?.access_token).toBe('AT');
    expect(done.tokens?.refresh_token).toBe('RT');
    expect(done.tokens?.scope).toBe('x');
    expect(typeof done.tokens?.expires_at).toBe('number');
    expect(done.tokens?.extra).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
  });

  it('maps expired_token → expired (accepts verification_url alias)', async () => {
    const fetchMock = (async (url: RequestInfo | URL) => {
      if (String(url).includes('device_authorization')) {
        return res(200, { device_code: 'dc', user_code: 'UC', verification_url: 'https://v', expires_in: 600, interval: 5 });
      }
      return res(400, { error: 'expired_token' });
    }) as unknown as typeof fetch;
    const flow = await startDeviceCodeFlow({ deviceAuthUrl: 'https://h/device_authorization', tokenUrl: 'https://h/token', clientId: 'c', fetch: fetchMock });
    expect(flow.verificationUri).toBe('https://v');
    expect((await flow.poll()).status).toBe('expired');
  });

  it('throws on a malformed device-authorization response', async () => {
    const fetchMock = (async () => res(200, { user_code: 'x' })) as unknown as typeof fetch;
    await expect(
      startDeviceCodeFlow({ deviceAuthUrl: 'u', tokenUrl: 't', clientId: 'c', fetch: fetchMock }),
    ).rejects.toThrow(/missing/);
  });
});
