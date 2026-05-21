import { describe, it, expect, vi } from 'vitest';
import {
  EscalatingFetcher,
  type RenderBackend,
  type RenderResult,
} from '../render-backend.js';

function mockResult(partial: Partial<RenderResult> = {}): RenderResult {
  return {
    url: 'https://example.com',
    finalUrl: 'https://example.com',
    status: 200,
    html: '<html><body>ok</body></html>',
    contentType: 'text/html',
    bytes: 100,
    via: 'plain',
    ...partial,
  };
}

function fakeBackend(name: 'plain' | 'browser', result: RenderResult, available = true): RenderBackend {
  return {
    name,
    isAvailable: async () => available,
    render: async () => ({ ...result, via: name === 'browser' ? 'browser' : 'plain' }),
  };
}

describe('EscalatingFetcher', () => {
  it('returns plain result when no block signals fire', async () => {
    const plain = fakeBackend('plain', mockResult({ status: 200, bytes: 5000 }));
    const browser = fakeBackend('browser', mockResult());
    const browserSpy = vi.spyOn(browser, 'render');
    const fetcher = new EscalatingFetcher(plain, browser, () => []);

    const out = await fetcher.render('https://example.com');
    expect(out.via).toBe('plain');
    expect(out.blockedSignals).toBeUndefined();
    expect(browserSpy).not.toHaveBeenCalled();
  });

  it('escalates to browser when signals fire AND browser is available', async () => {
    const plain = fakeBackend('plain', mockResult({ status: 403 }));
    const browser = fakeBackend('browser', mockResult({ status: 200, bytes: 9000 }));
    const fetcher = new EscalatingFetcher(plain, browser, () => ['http_403']);

    const out = await fetcher.render('https://blocked.example');
    expect(out.via).toBe('browser');
    expect(out.status).toBe(200);
    expect(out.blockedSignals).toEqual(['http_403']);
  });

  it('keeps plain result when browser is null', async () => {
    const plain = fakeBackend('plain', mockResult({ status: 403 }));
    const fetcher = new EscalatingFetcher(plain, null, () => ['http_403']);
    const out = await fetcher.render('https://no-browser.example');
    expect(out.via).toBe('plain');
    expect(out.blockedSignals).toEqual(['http_403']);
  });

  it('keeps plain result when browser exists but isAvailable=false', async () => {
    const plain = fakeBackend('plain', mockResult({ status: 403 }));
    const browser = fakeBackend('browser', mockResult({ status: 200 }), false);
    const browserSpy = vi.spyOn(browser, 'render');
    const fetcher = new EscalatingFetcher(plain, browser, () => ['http_403']);

    const out = await fetcher.render('https://browser-down.example');
    expect(out.via).toBe('plain');
    expect(out.blockedSignals).toEqual(['http_403']);
    expect(browserSpy).not.toHaveBeenCalled();
  });

  it('falls back to plain with browser_failed signal when browser.render throws', async () => {
    const plain = fakeBackend('plain', mockResult({ status: 403 }));
    const browser: RenderBackend = {
      name: 'browser',
      isAvailable: async () => true,
      render: async () => { throw new Error('chromium dead'); },
    };
    const fetcher = new EscalatingFetcher(plain, browser, () => ['http_403']);
    const out = await fetcher.render('https://browser-throws.example');
    expect(out.via).toBe('plain');
    expect(out.blockedSignals).toEqual(['http_403', 'browser_failed']);
  });
});
