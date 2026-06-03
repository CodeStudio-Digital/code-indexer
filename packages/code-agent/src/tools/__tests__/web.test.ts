/**
 * SSRF host-guard tests for web_fetch.
 *
 * `isBlockedFetchHost` is the hostname-level defense that refuses fetches to
 * private/loopback/link-local IPs (v4 + v6), IPv4-mapped IPv6, and obfuscated
 * numeric/hex IP literals. It does NOT defeat DNS-rebinding (out of scope).
 */
import { describe, expect, it } from 'vitest';
import { isBlockedFetchHost } from '@mcp/code-agent/tools/web.js';

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
