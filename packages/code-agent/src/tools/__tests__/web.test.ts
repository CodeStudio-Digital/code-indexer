/**
 * SSRF host-guard tests for web_fetch.
 *
 * `isBlockedFetchHost` is the hostname-level defense that refuses fetches to
 * private/loopback/link-local IPs (v4 + v6), IPv4-mapped IPv6, and obfuscated
 * numeric/hex IP literals. It does NOT defeat DNS-rebinding (out of scope).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { isBlockedFetchHost, webFetch, webSearch } from '@mcp/code-agent/tools/web.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('isBlockedFetchHost', () => {
  it('blocks loopback / private / link-local IPv4', () => {
    for (const host of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1',
      '0.0.0.0',
      '0.1.2.3',
    ]) {
      expect(isBlockedFetchHost(host), host).toBe(true);
    }
  });

  it('blocks localhost and *.localhost', () => {
    expect(isBlockedFetchHost('localhost')).toBe(true);
    expect(isBlockedFetchHost('LocalHost')).toBe(true);
    expect(isBlockedFetchHost('foo.localhost')).toBe(true);
  });

  it('blocks obfuscated numeric / hex IPv4 literals', () => {
    for (const host of [
      '2130706433', // 127.0.0.1 as a 32-bit int
      '0x7f000001', // 127.0.0.1 in hex
      '0177.0.0.1', // octal first octet
      '0x7f.0.0.1', // hex dotted
    ]) {
      expect(isBlockedFetchHost(host), host).toBe(true);
    }
  });

  it('blocks loopback / ULA / link-local / mapped IPv6 (with or without brackets)', () => {
    for (const host of [
      '::1',
      '[::1]',
      '::',
      '[::ffff:127.0.0.1]', // IPv4-mapped loopback
      '[fe80::1]', // link-local
      '[fc00::1]', // unique-local
      '[fd12:3456::1]', // unique-local
      'fe80::1%eth0', // zone id stripped
    ]) {
      expect(isBlockedFetchHost(host), host).toBe(true);
    }
  });

  it('allows public hostnames and public IPs', () => {
    for (const host of [
      'example.com',
      'docs.rust-lang.org',
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1', // just below the private 172.16/12 block
      '172.32.0.1', // just above it
      '[2606:4700:4700::1111]', // public IPv6 (Cloudflare)
    ]) {
      expect(isBlockedFetchHost(host), host).toBe(false);
    }
  });
});


let nextSession = 0;
function context(read: (input: import('@mcp/shared/utils/public-web-request.js').PublicWebRequest) => Promise<import('@mcp/shared/utils/public-web-request.js').PublicWebResponse>, signal?: AbortSignal): ToolContext {
  return { sessionId: 'web-test-' + ++nextSession, signal, ports: { web: { read, assertCurrent() { signal?.throwIfAborted(); } } } } as ToolContext;
}
function response(text: string, extra: Partial<import('@mcp/shared/utils/public-web-request.js').PublicWebResponse> = {}) {
  return { url: 'https://example.com/result', status: 200, statusText: 'OK', text,
    contentType: 'text/plain', truncated: false, inputBytes: Buffer.byteLength(text), inputSizeExact: true, ...extra };
}

describe('web tools with an owned transport', () => {
  it('preserves large acquired pages for durable output recovery', async () => {
    const ctx = context(async () => response('x'.repeat(20000) + 'TAIL_SENTINEL'));
    const result = await webFetch.handler({ url: 'https://example.com/large' }, ctx);
    expect(result.isError).toBeFalsy(); expect(result.content).toContain('TAIL_SENTINEL');
    expect(result.content.length).toBeGreaterThan(20000);
  });
  it('reports a partial source truthfully and preserves that metadata in the cache', async () => {
    const read = vi.fn(async (_input: import('@mcp/shared/utils/public-web-request.js').PublicWebRequest) => response('p'.repeat(32000), { truncated: true, inputBytes: 32768, inputSizeExact: false }));
    const ctx = context(read);
    const first = await webFetch.handler({ url: 'https://example.com/cap', max_bytes: 32000 }, ctx);
    expect(read.mock.calls[0][0].maxBytes).toBe(32000);
    expect(first.sourceTruncations).toEqual([expect.objectContaining({ inputSize: 32768, inputSizeExact: false, outputSize: 32000, recoverable: false })]);
    const cached = await webFetch.handler({ url: 'https://example.com/cap', max_bytes: 32000 }, ctx);
    expect(cached.content).toContain('[cached]'); expect(cached.sourceTruncations).toEqual(first.sourceTruncations);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('cancellation and revoked authority reject even a warm cache', async () => {
    const ctrl = new AbortController(); const ctx = context(async () => response('cached page'), ctrl.signal);
    await webFetch.handler({ url: 'https://example.com/cache-cancel' }, ctx);
    ctrl.abort(new Error('owner cancelled'));
    const cancelled = await webFetch.handler({ url: 'https://example.com/cache-cancel' }, ctx);
    expect(cancelled.isError).toBe(true); expect(cancelled.content).toContain('owner cancelled');
  });
  it('does not reuse another session cache', async () => {
    const read = vi.fn(async () => response('page'));
    await webFetch.handler({ url: 'https://example.com/session-cache' }, context(read));
    await webFetch.handler({ url: 'https://example.com/session-cache' }, context(read));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects URL credentials and private/obfuscated hosts before dispatch', async () => {
    const read = vi.fn(async () => response('must not run')); const ctx = context(read);
    for (const url of ['http://localhost./', 'http://[::ffff:7f00:1]/', 'http://user:password@example.com/', 'file:///tmp/a']) {
      expect((await webFetch.handler({ url }, ctx)).isError, url).toBe(true);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('converts HTML tables, code and JSON in real workers, removes scripts', async () => {
    const ctx = context(async () => response('<html><h1>Heading</h1><script>LEAK_SENTINEL</script><pre><code>const x = 1;</code></pre><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table></html>', { contentType: 'text/html' }));
    const html = await webFetch.handler({ url: 'https://example.com/html' }, ctx);
    expect(html.isError).toBeFalsy(); expect(html.content).toContain('# Heading'); expect(html.content).toContain('| Name |');
    expect(html.content).not.toContain('LEAK_SENTINEL');
    const json = await webFetch.handler({ url: 'https://example.com/json' }, context(async () => response('{"ok":true}', { contentType: 'application/json' })));
    expect(json.content).toContain('"ok": true');
  });
  it('bounds search reads and matches hostnames, excluding deceptive URLs and private links', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'fixture-token');
    const urls = ['https://docs.python.org/page', 'https://python.org.evil.example/page', 'https://evil.example/?python.org', 'https://localhost/', 'javascript:alert(1)', 'https://old.python.org/page'];
    const read = vi.fn(async (_input: import('@mcp/shared/utils/public-web-request.js').PublicWebRequest) => response(JSON.stringify({ web: { results: urls.map(url => ({ url, title: url, description: 'Description' })) } }), { contentType: 'application/json' }));
    const result = await webSearch.handler({ query: 'python docs', allowed_domains: ['python.org'], blocked_domains: ['old.python.org'] }, context(read));
    expect(result.isError).toBeFalsy(); expect(result.content).toContain('https://docs.python.org/page');
    expect(result.content).not.toContain('evil.example'); expect(result.content).not.toContain('localhost');
    expect(result.content).not.toContain('old.python.org'); expect(read.mock.calls[0][0].maxBytes).toBe(2 * 1024 * 1024);
  });
  it('never starts fallback after cancellation', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'fixture-token'); const ctrl = new AbortController();
    const read = vi.fn(async () => { ctrl.abort(new Error('cancel search')); throw new Error('failed'); });
    const result = await webSearch.handler({ query: 'cancel docs' }, context(read, ctrl.signal));
    expect(result.isError).toBe(true); expect(read).toHaveBeenCalledTimes(1);
  });
  it('falls back on backend errors and decodes DDG URLs only once', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'fixture-token');
    const ddg = '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F%2520">Title</a><a class="result__snippet">Snippet</a>';
    const read = vi.fn().mockResolvedValueOnce(response('', { status: 503 })).mockResolvedValueOnce(response(ddg, { contentType: 'text/html' }));
    const result = await webSearch.handler({ query: 'fallback docs' }, context(read));
    expect(result.isError).toBeFalsy(); expect(result.content).toContain('duckduckgo (brave failed)');
    expect(result.content).toContain('https://example.com/%20');
  });
  it('does not parse silently truncated search responses', async () => {
    vi.stubEnv('BRAVE_API_KEY', '');
    const result = await webSearch.handler({ query: 'large search' }, context(async () => response('partial', { truncated: true })));
    expect(result.isError).toBe(true); expect(result.content).toContain('acquisition ceiling');
  });
});
