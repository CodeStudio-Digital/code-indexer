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

describe('EscalatingFetcher.forceBrowser', () => {
  it('skips plain entirely and renders via browser when forceBrowser=true (happy path)', async () => {
    // detectBlocked() returns [] — would NOT escalate normally. Force flag
    // is the only thing that should trigger the browser fetch.
    const plain = fakeBackend('plain', mockResult({ status: 200, bytes: 9000 }));
    const plainSpy = vi.spyOn(plain, 'render');
    const browser = fakeBackend('browser', mockResult({ status: 200, bytes: 12000 }));

    const fetcher = new EscalatingFetcher(plain, browser, () => []);
    const out = await fetcher.render('https://unity-docs.example', { forceBrowser: true });

    expect(out.via).toBe('browser');
    expect(out.blockedSignals).toEqual(['force_browser']);
    // Plain MUST NOT have been called — the entire point of force_browser.
    expect(plainSpy).not.toHaveBeenCalled();
  });

  it('falls back to plain with force_browser_unavailable when no browser is wired', async () => {
    const plain = fakeBackend('plain', mockResult({ status: 200 }));
    const fetcher = new EscalatingFetcher(plain, null, () => []);

    const out = await fetcher.render('https://x.example', { forceBrowser: true });
    expect(out.via).toBe('plain');
    expect(out.blockedSignals).toEqual(['force_browser_unavailable']);
  });

  it('falls back to plain with force_browser_unavailable when browser.isAvailable=false', async () => {
    const plain = fakeBackend('plain', mockResult({ status: 200 }));
    const browser = fakeBackend('browser', mockResult(), false);
    const browserRenderSpy = vi.spyOn(browser, 'render');

    const fetcher = new EscalatingFetcher(plain, browser, () => []);
    const out = await fetcher.render('https://x.example', { forceBrowser: true });

    expect(out.via).toBe('plain');
    expect(out.blockedSignals).toEqual(['force_browser_unavailable']);
    // We probed isAvailable but never actually called render on the dead
    // browser — saves 30s when the container is known-down.
    expect(browserRenderSpy).not.toHaveBeenCalled();
  });

  it('falls back to plain with both force_browser and force_browser_failed when browser throws', async () => {
    const plain = fakeBackend('plain', mockResult({ status: 200 }));
    const browser: RenderBackend = {
      name: 'browser',
      isAvailable: async () => true,
      render: async () => { throw new Error('navigation timeout'); },
    };
    const fetcher = new EscalatingFetcher(plain, browser, () => []);

    const out = await fetcher.render('https://x.example', { forceBrowser: true });
    expect(out.via).toBe('plain');
    // Both signals so callers can distinguish "Chromium was tried but
    // crashed mid-render" from "Chromium was off".
    expect(out.blockedSignals).toEqual(['force_browser', 'force_browser_failed']);
  });

  it('ignores the legacy heuristic when forceBrowser=true (no double-attempt)', async () => {
    // Plain returns a result that WOULD trigger escalation by the
    // heuristic. With forceBrowser=true we should not even call plain;
    // therefore detectBlocked should not run on a plain result.
    const detectSpy = vi.fn(() => ['http_403']);
    const plain = fakeBackend('plain', mockResult({ status: 403 }));
    const plainSpy = vi.spyOn(plain, 'render');
    const browser = fakeBackend('browser', mockResult({ status: 200, bytes: 9000 }));

    const fetcher = new EscalatingFetcher(plain, browser, detectSpy);
    const out = await fetcher.render('https://x.example', { forceBrowser: true });

    expect(out.via).toBe('browser');
    expect(out.blockedSignals).toEqual(['force_browser']);
    expect(plainSpy).not.toHaveBeenCalled();
    expect(detectSpy).not.toHaveBeenCalled();
  });

  it('forceBrowser=false (or omitted) preserves the legacy heuristic behavior', async () => {
    // Sanity guard: the new branch must not break the default code path.
    const plain = fakeBackend('plain', mockResult({ status: 200, bytes: 5000 }));
    const browser = fakeBackend('browser', mockResult());
    const browserSpy = vi.spyOn(browser, 'render');
    const fetcher = new EscalatingFetcher(plain, browser, () => []);

    const out = await fetcher.render('https://x.example', { forceBrowser: false });
    expect(out.via).toBe('plain');
    expect(out.blockedSignals).toBeUndefined();
    expect(browserSpy).not.toHaveBeenCalled();
  });
});
