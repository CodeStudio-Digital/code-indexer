/**
 * SSRF host-guard tests for web_fetch.
 *
 * `isBlockedFetchHost` is the hostname-level defense that refuses fetches to
 * private/loopback/link-local IPs (v4 + v6), IPv4-mapped IPv6, and obfuscated
 * numeric/hex IP literals. It does NOT defeat DNS-rebinding (out of scope).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { isBlockedFetchHost, webFetch } from '@mcp/code-agent/tools/web.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

describe('web_fetch output ownership', () => {
  it('returns a large page intact so runner-level spill can preserve it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `${'x'.repeat(20_000)}TAIL_SENTINEL`,
      { status: 200, headers: { 'content-type': 'text/plain' } },
    )));

    const result = await webFetch.handler(
      { url: 'https://example.com/smart-reducer-large-page' },
      {} as ToolContext,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('TAIL_SENTINEL');
    expect(result.content.length).toBeGreaterThan(20_000);
  });

  it('bounds network acquisition explicitly and keeps the acquired prefix', async () => {
    const fetchMock = vi.fn(async () => new Response(
      `${'p'.repeat(80_000)}UNREAD_TAIL`,
      { status: 200, headers: { 'content-type': 'text/plain' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetch.handler(
      { url: 'https://example.com/acquisition-boundary', max_bytes: 32_000 },
      {} as ToolContext,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('p'.repeat(1000));
    expect(result.content).toContain('[source truncated: web transfer stopped');
    expect(result.content).not.toContain('UNREAD_TAIL');
    expect(result.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'network-acquisition-cap',
        unit: 'bytes',
        inputSizeExact: false,
        outputSize: 32_000,
        recoverable: false,
      }),
    ]);

    const cached = await webFetch.handler(
      { url: 'https://example.com/acquisition-boundary', max_bytes: 32_000 },
      {} as ToolContext,
    );
    expect(cached.content).toContain('[cached]');
    expect(cached.sourceTruncations).toEqual(result.sourceTruncations);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps only complete UTF-8 code points when max_bytes cuts through a character', async () => {
    const maxBytes = 1024;
    const completePrefix = 'a'.repeat(maxBytes - 2);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `${completePrefix}🙂UNREAD_TAIL`,
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )));

    const result = await webFetch.handler(
      { url: 'https://example.com/unicode-acquisition-boundary', max_bytes: maxBytes },
      {} as ToolContext,
    );

    expect(result.isError).toBeFalsy();
    const acquiredBody = result.content
      .split('\n\n---\n\n')[1]
      .split('\n\n[source truncated:')[0];
    expect(acquiredBody).toBe(completePrefix);
    expect(acquiredBody).not.toContain('\uFFFD');
    expect(Buffer.byteLength(acquiredBody, 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(result.content).not.toContain('UNREAD_TAIL');
  });

  it('does not mistake compressed wire Content-Length for decoded source size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `${'z'.repeat(80_000)}UNREAD_TAIL`,
      {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-encoding': 'gzip',
          'content-length': '90000',
        },
      },
    )));

    const result = await webFetch.handler(
      { url: 'https://example.com/compressed-acquisition-boundary', max_bytes: 32_000 },
      {} as ToolContext,
    );

    expect(result.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'network-acquisition-cap',
        inputSizeExact: false,
        outputSize: 32_000,
      }),
    ]);
    expect(result.sourceTruncations![0]!.inputSize).not.toBe(90_000);
  });

  it('keeps the timeout active while a response body is stalled', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial body'));
          signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    }));

    const pending = webFetch.handler(
      { url: 'https://example.com/stalled-body' },
      {} as ToolContext,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/web_fetch failed:.*abort/i);
  });
});
