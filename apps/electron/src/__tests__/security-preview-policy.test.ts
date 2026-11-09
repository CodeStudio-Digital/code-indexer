import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobalHardening } from '../security-hardening.js';

const electron = vi.hoisted(() => ({
  app: { isPackaged: true },
  ipcMain: { on: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));
vi.mock('electron', () => electron);
vi.mock('../edit-menu.js', () => ({ installEditMenu: vi.fn() }));

const appUrl = 'file:///C:/CodeStudio/resources/app.asar/dist/dashboard/index.html';
type HeadersHandler = (details: { url: string; resourceType: string; responseHeaders?: Record<string, string[]> }, callback: ReturnType<typeof vi.fn>) => void;

function handler(): HeadersHandler {
  installGlobalHardening(appUrl);
  return electron.session.defaultSession.webRequest.onHeadersReceived.mock.calls.at(-1)![0];
}

describe('packaged dashboard CSP scope', () => {
  beforeEach(() => { vi.clearAllMocks(); electron.app.isPackaged = true; });

  it.each([appUrl, `${appUrl}#/projects/1`])('protects the trusted dashboard document %s', url => {
    const callback = vi.fn();
    handler()({ url, resourceType: 'mainFrame', responseHeaders: { 'Content-Type': ['text/html'] } }, callback);
    const headers = callback.mock.calls[0]![0].responseHeaders;
    expect(headers['Content-Type']).toEqual(['text/html']);
    expect(headers['Content-Security-Policy'][0]).toContain("script-src 'self' 'wasm-unsafe-eval' 'nonce-");
    expect(headers['Content-Security-Policy'][0]).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each([
    ['http://localhost:65244/', 'subFrame'],
    ['http://127.0.0.1:5173/login', 'subFrame'],
    ['http://[::1]:5173/', 'subFrame'],
    ['https://example.test/', 'subFrame'],
    ['http://localhost:65244/', 'mainFrame'],
    ['http://localhost:65244/bootstrap.js', 'script'],
    ['http://localhost:65244/redirect', 'subFrame'],
    ['mcp://app/api/projects', 'xhr'],
    ['file:///C:/report.html', 'mainFrame'],
    [`${appUrl}.untrusted.html`, 'mainFrame'],
    [appUrl, 'subFrame'],
  ])('preserves headers and policies for %s (%s)', (url, resourceType) => {
    const ownPolicy = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'";
    const responseHeaders = Object.freeze({
      'content-security-policy': [ownPolicy],
      'Content-Security-Policy-Report-Only': ["default-src 'none'"],
      'X-Frame-Options': ['SAMEORIGIN'],
    });
    const callback = vi.fn();
    handler()({ url, resourceType, responseHeaders }, callback);
    // Omitting responseHeaders tells Electron to keep the server response
    // untouched, including restrictive frame policies and reporting headers.
    expect(callback).toHaveBeenCalledExactlyOnceWith({});
    expect(responseHeaders['content-security-policy']).toEqual([ownPolicy]);
  });

  it('leaves documents without a CSP untouched as well', () => {
    const callback = vi.fn();
    handler()({ url: 'http://localhost:3000/', resourceType: 'subFrame' }, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith({});
  });

  it('does not install a production policy in development', () => {
    electron.app.isPackaged = false;
    installGlobalHardening(appUrl);
    expect(electron.session.defaultSession.webRequest.onHeadersReceived).not.toHaveBeenCalled();
  });
});
