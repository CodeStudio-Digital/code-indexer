import { describe, it, expect, beforeEach } from 'vitest';
import {
  BREAKER_WINDOW_MS,
  RETRY_BACKOFF_MS,
  clearBreaker,
  isBreakerOpen,
  planRetry,
  preflightBrowser,
  probeUrlFromWsEndpoint,
  resetAllBreakers,
  tripBreaker,
  type ProbeOutcome,
} from '../qa-preflight.js';

beforeEach(() => resetAllBreakers());

// ─── planRetry (pure) ────────────────────────────────────────────

describe('planRetry', () => {
  it('asks for an immediate probe when nothing ran yet', () => {
    expect(planRetry([], 0)).toEqual({ action: 'retry', delayMs: 0 });
  });

  it('returns ok when the last probe succeeded', () => {
    const outcomes: ProbeOutcome[] = [{ ok: false, atMs: 0 }, { ok: true, atMs: 10 }];
    expect(planRetry(outcomes, 20)).toEqual({ action: 'ok' });
  });

  it('backs off 1s/3s/9s across consecutive failures', () => {
    const fail = (atMs: number): ProbeOutcome => ({ ok: false, atMs });
    expect(planRetry([fail(0)], 0)).toEqual({ action: 'retry', delayMs: 1_000 });
    expect(planRetry([fail(0), fail(1_000)], 1_000)).toEqual({ action: 'retry', delayMs: 3_000 });
    expect(planRetry([fail(0), fail(1_000), fail(4_000)], 4_000))
      .toEqual({ action: 'retry', delayMs: 9_000 });
  });

  it('gives up after exhausting the 3 retries', () => {
    const outcomes: ProbeOutcome[] = [0, 1, 2, 3].map((atMs) => ({ ok: false, atMs }));
    expect(planRetry(outcomes, 4)).toEqual({ action: 'give_up' });
  });

  it('discounts time already elapsed since the last attempt', () => {
    expect(planRetry([{ ok: false, atMs: 0 }], 400)).toEqual({ action: 'retry', delayMs: 600 });
    expect(planRetry([{ ok: false, atMs: 0 }], 5_000)).toEqual({ action: 'retry', delayMs: 0 });
  });

  it('exposes the documented backoff schedule', () => {
    expect(RETRY_BACKOFF_MS).toEqual([1_000, 3_000, 9_000]);
  });
});

// ─── breaker ─────────────────────────────────────────────────────

describe('circuit breaker', () => {
  it('opens on trip and closes after the 60s window', () => {
    tripBreaker(7, 1_000);
    expect(isBreakerOpen(7, 1_000)).toBe(true);
    expect(isBreakerOpen(7, 1_000 + BREAKER_WINDOW_MS - 1)).toBe(true);
    expect(isBreakerOpen(7, 1_000 + BREAKER_WINDOW_MS)).toBe(false);
  });

  it('is per-session and clearable', () => {
    tripBreaker(7, 0);
    expect(isBreakerOpen(8, 0)).toBe(false);
    clearBreaker(7);
    expect(isBreakerOpen(7, 0)).toBe(false);
  });
});

// ─── probe URL derivation ────────────────────────────────────────

describe('probeUrlFromWsEndpoint', () => {
  it('maps the container alias onto host loopback, same port', () => {
    expect(probeUrlFromWsEndpoint('ws://host.containers.internal:9223/'))
      .toBe('http://127.0.0.1:9223/');
    expect(probeUrlFromWsEndpoint('ws://host.docker.internal:9222'))
      .toBe('http://127.0.0.1:9222/');
  });

  it('rejects non-ws URLs and garbage', () => {
    expect(probeUrlFromWsEndpoint('http://x:1/')).toBeNull();
    expect(probeUrlFromWsEndpoint('not a url')).toBeNull();
  });
});

// ─── preflightBrowser ────────────────────────────────────────────

function makeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    advance: (ms: number) => { t += ms; },
    sleeps,
  };
}

const okResponse = { ok: true, status: 200, text: async () => 'Running' } as unknown as Response;

function fakeChromeService(status: string) {
  return {
    getEndpoint: async () => ({
      status,
      wsEndpoint: 'ws://host.containers.internal:9223/',
      loopbackHealthUrl: 'http://127.0.0.1:9223/',
      lastError: status === 'error' ? 'boom' : null,
    }),
  };
}

describe('preflightBrowser — chrome_service source (main process)', () => {
  it('succeeds on the first healthy probe', async () => {
    const clock = makeClock();
    const urls: string[] = [];
    const result = await preflightBrowser({
      sessionId: 1,
      getChromeService: () => fakeChromeService('running'),
      fetchImpl: (async (url: string) => { urls.push(url); return okResponse; }) as unknown as typeof fetch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('chrome_service');
    expect(result.attempts).toBe(1);
    expect(urls).toEqual(['http://127.0.0.1:9223/']);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries with backoff then gives up typed (sidecar_down) and trips the breaker', async () => {
    const clock = makeClock();
    let calls = 0;
    const result = await preflightBrowser({
      sessionId: 2,
      getChromeService: () => fakeChromeService('running'),
      fetchImpl: (async () => { calls++; throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('sidecar_down');
    expect(result.attempts).toBe(4); // 1 initial + 3 retries
    expect(calls).toBe(4);
    expect(clock.sleeps).toEqual([1_000, 3_000, 9_000]);
    expect(result.message).toContain('Admin');
    expect(isBreakerOpen(2, clock.now())).toBe(true);
  });

  it('short-circuits without re-probing while the breaker is open', async () => {
    tripBreaker(3, 0);
    let calls = 0;
    const result = await preflightBrowser({
      sessionId: 3,
      getChromeService: () => fakeChromeService('running'),
      fetchImpl: (async () => { calls++; return okResponse; }) as unknown as typeof fetch,
      now: () => 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.breakerOpen).toBe(true);
    expect(calls).toBe(0);
  });

  it('fails fast (no probes) when the service is stopped', async () => {
    let calls = 0;
    const result = await preflightBrowser({
      sessionId: 4,
      getChromeService: () => fakeChromeService('stopped'),
      fetchImpl: (async () => { calls++; return okResponse; }) as unknown as typeof fetch,
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);
    expect(calls).toBe(0);
    expect(result.message).toContain('stopped');
  });
});

describe('preflightBrowser — env_probe source (worker: ChromeService null)', () => {
  const envStore = {
    list: (_sessionId: number) => [
      { key: 'PLAYWRIGHT_WS_ENDPOINT', value: 'ws://host.containers.internal:9223/' },
    ],
  } as never;

  it('falls back to the session env PLAYWRIGHT_WS_ENDPOINT and probes loopback', async () => {
    const urls: string[] = [];
    const result = await preflightBrowser({
      sessionId: 5,
      getChromeService: () => null,
      envStore,
      fetchImpl: (async (url: string) => { urls.push(url); return okResponse; }) as unknown as typeof fetch,
      now: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('env_probe');
    expect(result.wsEndpoint).toBe('ws://host.containers.internal:9223/');
    expect(urls).toEqual(['http://127.0.0.1:9223/']);
  });

  it('fails typed when the env var was never wired', async () => {
    const result = await preflightBrowser({
      sessionId: 6,
      getChromeService: () => null,
      envStore: { list: () => [] } as never,
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('sidecar_down');
    expect(result.message).toContain('PLAYWRIGHT_WS_ENDPOINT');
  });
});
