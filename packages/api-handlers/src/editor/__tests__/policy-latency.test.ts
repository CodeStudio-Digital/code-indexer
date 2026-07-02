import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveLatencyPolicy, adaptiveDebounce, noteOkLatency, resolveGenParams,
  __resetLatencyPolicyForTests,
} from '../completion/policy.js';
import { rememberCompletion, forwardMatch, __resetForwardCacheForTests } from '../completion/forward-cache.js';

beforeEach(() => {
  __resetLatencyPolicyForTests();
  __resetForwardCacheForTests();
});

describe('resolveLatencyPolicy', () => {
  it('maps the aggressiveness table', () => {
    expect(resolveLatencyPolicy({ aggressiveness: 'economic' })).toMatchObject({
      debounceBaseMs: 250, cacheTtlMs: 90_000, suppression: 'strict',
    });
    expect(resolveLatencyPolicy({})).toMatchObject({
      aggressiveness: 'balanced', debounceBaseMs: 180, suppression: 'standard',
    });
    expect(resolveLatencyPolicy({ aggressiveness: 'responsive' })).toMatchObject({
      debounceBaseMs: 120, suppression: 'lenient',
    });
  });

  it('explicit debounce_ms always wins (base and adaptive)', () => {
    const policy = resolveLatencyPolicy({ debounce_ms: 300 });
    for (let i = 0; i < 20; i++) noteOkLatency('p:m', 100);
    expect(adaptiveDebounce('p:m', policy)).toBe(300);
  });
});

describe('adaptiveDebounce', () => {
  it('shortens for a fast provider, respects the floor', () => {
    const policy = resolveLatencyPolicy({});
    expect(adaptiveDebounce('p:m', policy)).toBe(180); // no window yet
    for (let i = 0; i < 20; i++) noteOkLatency('p:m', 200);
    expect(adaptiveDebounce('p:m', policy)).toBe(120); // 180-60
  });

  it('lengthens for a slow provider', () => {
    const policy = resolveLatencyPolicy({});
    for (let i = 0; i < 20; i++) noteOkLatency('p:m', 2500);
    expect(adaptiveDebounce('p:m', policy)).toBe(300); // 180+120
  });

  it('keeps a rolling window (recovers after the model speeds up)', () => {
    const policy = resolveLatencyPolicy({});
    for (let i = 0; i < 20; i++) noteOkLatency('p:m', 2500);
    for (let i = 0; i < 20; i++) noteOkLatency('p:m', 150); // window fully replaced
    expect(adaptiveDebounce('p:m', policy)).toBe(120);
  });
});

describe('resolveGenParams', () => {
  it('FIM defaults to temp 0.05, chat to 0.2; single-line caps tokens at 64', () => {
    expect(resolveGenParams({}, 'fim', true)).toEqual({ temperature: 0.05, maxTokens: 256 });
    expect(resolveGenParams({}, 'chat', true)).toEqual({ temperature: 0.2, maxTokens: 256 });
    expect(resolveGenParams({}, 'fim', false)).toEqual({ temperature: 0.05, maxTokens: 64 });
  });

  it('explicit config wins, including temperature 0', () => {
    expect(resolveGenParams({ temperature: 0, max_tokens: 128 }, 'chat', true))
      .toEqual({ temperature: 0, maxTokens: 128 });
    expect(resolveGenParams({ max_tokens_single_line: 32 }, 'fim', false).maxTokens).toBe(32);
  });
});

describe('forward-cache (server)', () => {
  it('serves the remainder when the user types through the completion', () => {
    rememberCompletion(1, 'a.php', 10, 'foo(', 'bar, baz);', 'req-1');
    const hit = forwardMatch(1, 'a.php', 10, 'foo(bar,');
    expect(hit).toEqual({ text: ' baz);', requestId: 'req-1' });
  });

  it('misses on divergent typing, other lines, or full consumption', () => {
    rememberCompletion(1, 'a.php', 10, 'foo(', 'bar);', 'req-1');
    expect(forwardMatch(1, 'a.php', 10, 'foo(qux')).toBeNull();
    expect(forwardMatch(1, 'a.php', 11, 'foo(bar')).toBeNull();
    expect(forwardMatch(1, 'a.php', 10, 'foo(bar);')).toBeNull(); // typed it all
    expect(forwardMatch(1, 'a.php', 10, 'foo(')).toBeNull();      // nothing typed → exact cache's job
  });
});
