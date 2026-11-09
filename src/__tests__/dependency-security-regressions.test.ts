import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Resolve the dependency used by each consumer, not an arbitrary hoisted copy.
const modules = fileURLToPath(new URL('../../node_modules/', import.meta.url));
function consumerRequire(name: string) {
  for (const base of [modules, join(modules, '.pnpm', 'node_modules')]) {
    const manifest = join(base, name, 'package.json');
    if (existsSync(manifest)) return createRequire(realpathSync(manifest));
  }
  throw new Error(`Missing installed consumer: ${name}`);
}

interface ShellQuote {
  quote(tokens: unknown[]): string;
  parse(source: string): unknown[];
}
const quotes = ['concurrently', '@scalar/api-client'].map(consumer => {
  const consumerLoader = consumerRequire(consumer);
  return { consumer, api: consumerLoader('shell-quote') as ShellQuote, version: consumerLoader('shell-quote/package.json').version as string };
});
interface ProxyRequest { headers: Record<string, string>; socket: { remoteAddress: string }; connection: { remoteAddress: string } }
type Trust = (address: string, index: number) => boolean;
interface ProxyAddr { (request: ProxyRequest, trust: Trust): string; compile(subnets: string | string[]): Trust }
const expressRequire = consumerRequire('express');
const proxy = expressRequire('proxy-addr') as ProxyAddr;
const proxyVersion = expressRequire('proxy-addr/package.json').version as string;
const overrides = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).pnpm.overrides as Record<string, string>;

describe('dependency security regressions — pure parsing, no shell/network', () => {
  it('loads the pinned repaired versions through every affected consumer', () => {
    for (const quote of quotes) expect(quote.version).toBe(overrides['shell-quote']);
    expect(proxyVersion).toBe(overrides['proxy-addr']);
  });

  // https://github.com/ljharb/shell-quote/security/advisories/GHSA-w7jw-789q-3m8p
  // https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv
  for (const { consumer, api } of quotes) {
    it.each(['\n', '\r', '\u2028', '\u2029'])(`${consumer} rejects line terminators in unsafe token positions (%j)`, (separator: string) => {
      expect(() => api.quote([{ op: `;${separator}fixture` }])).toThrow(TypeError);
      expect(() => api.quote([{ comment: `note${separator}fixture` }])).toThrow(TypeError);
      expect(() => api.quote(['echo', { comment: 'note' }, `value${separator}fixture`])).toThrow(TypeError);
    });

    it(`${consumer} preserves ordinary strings, operators and glob tokens`, () => {
      const strings = ['two words', "single'quote", 'semi;colon', '$literal', 'line\nbreak'];
      expect(api.parse(api.quote(strings))).toEqual(strings);
      const operators = ['echo', 'ok', { op: '&&' }, 'echo', 'done'];
      expect(api.quote(operators)).toContain('\\&\\&');
      expect(api.parse(api.quote(operators))).toEqual(['echo', 'ok', '&&', 'echo', 'done']);
      const glob = [{ op: 'glob', pattern: '*.ts' }];
      expect(api.parse(api.quote(glob))).toEqual(glob);
    });
  }

  // https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h
  it.each(['::ffff:10.0.0.0/8', '::/1'])('does not trust arbitrary IPv4 addresses via %s', (subnet: string) => {
    const trust = proxy.compile(subnet);
    expect(trust('203.0.113.10', 0)).toBe(false);
    const socket = { remoteAddress: '203.0.113.10' };
    expect(proxy({ socket, connection: socket, headers: { 'x-forwarded-for': '10.0.0.5' } }, trust)).toBe('203.0.113.10');
  });

  it.each(['10.0.0.0/8', '::ffff:10.0.0.0/104'])('preserves correctly scoped proxy trust for %s', (subnet: string) => {
    const trust = proxy.compile(subnet);
    expect(trust('10.1.2.3', 0)).toBe(true);
    expect(trust('203.0.113.10', 0)).toBe(false);
    const socket = { remoteAddress: '10.1.2.3' };
    expect(proxy({ socket, connection: socket, headers: { 'x-forwarded-for': '203.0.113.10' } }, trust)).toBe('203.0.113.10');
  });
});
