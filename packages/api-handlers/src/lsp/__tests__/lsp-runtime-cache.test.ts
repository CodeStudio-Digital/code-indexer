/**
 * TTL cache around resolveLspRuntime — the detectors sweep the filesystem
 * synchronously on the main loop, so acquire/status polls must not re-run
 * them within the TTL. Pure unit tests: detectors mocked with counters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@mcp/api-bus';

const { detectDotnet, detectJava } = vi.hoisted(() => ({
  detectDotnet: vi.fn((): Runtime[] => []),
  detectJava: vi.fn((): Runtime[] => []),
}));

vi.mock('../../runtime/detect-dotnet.js', () => ({ detectDotnetRuntimes: detectDotnet }));
vi.mock('../../runtime/detect-java.js', () => ({ detectJavaRuntimes: detectJava }));
vi.mock('@mcp/shared/utils/config.js', () => ({ mcpDataDir: () => '/data' }));

import { invalidateLspRuntimeCache, resolveLspRuntime } from '../lsp-runtime.js';

const sdk = (version: string): Runtime => ({
  kind: 'dotnet',
  id: `managed:${version}`,
  label: `.NET SDK ${version}`,
  version,
  binDir: `/dotnet/${version}`,
  source: 'managed',
  isManaged: true,
});

const dbWith = (runtimeVersions: string | null) =>
  ({ getProject: () => ({ runtime_versions: runtimeVersions }) }) as never;

const REQ = { kind: 'dotnet', minMajor: 6 } as const;

describe('resolveLspRuntime cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invalidateLspRuntimeCache();
    detectDotnet.mockClear();
    detectJava.mockClear();
    detectDotnet.mockImplementation(() => [sdk('8.0.100')]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a satisfied resolution from cache within the TTL', () => {
    const db = dbWith(null);
    const first = resolveLspRuntime(db, 1, REQ);
    const second = resolveLspRuntime(db, 1, REQ);
    expect(first.satisfied).toBe(true);
    expect(second).toBe(first);
    expect(detectDotnet).toHaveBeenCalledTimes(1);
  });

  it('re-detects once the satisfied TTL elapses', () => {
    const db = dbWith(null);
    resolveLspRuntime(db, 1, REQ);
    vi.advanceTimersByTime(60_001);
    resolveLspRuntime(db, 1, REQ);
    expect(detectDotnet).toHaveBeenCalledTimes(2);
  });

  it('re-probes an unsatisfied resolution after the short miss TTL', () => {
    detectDotnet.mockImplementation(() => []);
    const db = dbWith(null);
    expect(resolveLspRuntime(db, 1, REQ).satisfied).toBe(false);
    resolveLspRuntime(db, 1, REQ);
    expect(detectDotnet).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_001);
    resolveLspRuntime(db, 1, REQ);
    expect(detectDotnet).toHaveBeenCalledTimes(2);
  });

  it('invalidateLspRuntimeCache forces a fresh detection', () => {
    const db = dbWith(null);
    resolveLspRuntime(db, 1, REQ);
    invalidateLspRuntimeCache();
    resolveLspRuntime(db, 1, REQ);
    expect(detectDotnet).toHaveBeenCalledTimes(2);
  });

  it('changing the project runtime selection misses the cache (key embeds it)', () => {
    resolveLspRuntime(dbWith(null), 1, REQ);
    const picked = resolveLspRuntime(dbWith(JSON.stringify({ dotnet: 'managed:8.0.100' })), 1, REQ);
    expect(detectDotnet).toHaveBeenCalledTimes(2);
    expect(picked.satisfied).toBe(true);
    expect(picked.satisfied && picked.command).toContain('8.0.100');
  });

  it('caches java and dotnet independently per requirement kind', () => {
    detectJava.mockImplementation(() => []);
    const db = dbWith(null);
    resolveLspRuntime(db, 1, REQ);
    resolveLspRuntime(db, 1, { kind: 'java', minMajor: 21 });
    expect(detectDotnet).toHaveBeenCalledTimes(1);
    expect(detectJava).toHaveBeenCalledTimes(1);
  });
});
