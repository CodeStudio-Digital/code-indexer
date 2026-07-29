/**
 * Regression — the local IDE API was served with `cors({ origin: '*' })` as its
 * only global middleware. Any page open in the user's browser could then script
 * `fetch('http://127.0.0.1:7333/api/…')` and READ the response: project list,
 * file contents, the SSH host table and its `enc_*` blobs. Loopback is not a
 * boundary against the user's own browser.
 */
import { describe, expect, it } from 'vitest';
import { buildCorsOrigin, isLoopbackOrigin } from '../cors-origin.js';

describe('CORS origin policy', () => {
  const origin = buildCorsOrigin();

  it('reflects loopback origins on any port (Vite dev, preview windows)', () => {
    expect(origin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(origin('http://localhost:7317')).toBe('http://localhost:7317');
    expect(origin('http://127.0.0.1:7333')).toBe('http://127.0.0.1:7333');
    expect(origin('http://[::1]:7333')).toBe('http://[::1]:7333');
    expect(origin('https://localhost:8443')).toBe('https://localhost:8443');
  });

  it('reflects the Electron app scheme', () => {
    expect(origin('mcp://app')).toBe('mcp://app');
  });

  it('REFUSES remote origins — the whole point', () => {
    expect(origin('https://evil.test')).toBeNull();
    expect(origin('http://192.168.1.50:7333')).toBeNull();
    expect(origin('https://ads.example.com')).toBeNull();
  });

  it('refuses lookalike hostnames that merely contain a loopback name', () => {
    expect(origin('http://localhost.evil.test')).toBeNull();
    expect(origin('http://127.0.0.1.evil.test')).toBeNull();
    expect(origin('http://notlocalhost')).toBeNull();
  });

  it('refuses a sandboxed `null` origin and other non-URLs', () => {
    expect(origin('null')).toBeNull();
    expect(origin('')).toBeNull();
    expect(origin('not a url')).toBeNull();
  });

  it('refuses non-http schemes that are not the app scheme', () => {
    expect(origin('file://')).toBeNull();
    expect(origin('mcp://somewhere-else')).toBeNull();
    expect(origin('chrome-extension://abcdef')).toBeNull();
  });

  it('honours an explicit operator allowlist, exact match only', () => {
    const withList = buildCorsOrigin(['https://ide.internal.corp']);
    expect(withList('https://ide.internal.corp')).toBe('https://ide.internal.corp');
    // A prefix or subdomain of an allowlisted origin is NOT allowlisted.
    expect(withList('https://ide.internal.corp.evil.test')).toBeNull();
    expect(withList('https://other.internal.corp')).toBeNull();
  });

  it('isLoopbackOrigin ignores the path/credentials part of a URL', () => {
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('http://user@evil.test')).toBe(false);
  });
});
