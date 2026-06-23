import { describe, it, expect } from 'vitest';
import { createRunTelemetry, resolveRssWarnMb } from '../indexer/run-telemetry.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('run telemetry', () => {
  it('accumulates per-phase durations and samples a peak RSS', async () => {
    const t = createRunTelemetry({ sampleIntervalMs: 10 });
    await t.phase('scan', () => sleep(25));
    await t.phase('analyze', () => sleep(40));
    await t.phase('embed', () => sleep(5));
    // Re-entrant phase accumulates (the model-change sweep adds to 'embed').
    await t.phase('embed', () => sleep(5));
    const data = t.finish();

    expect(data.scan_ms).toBeGreaterThanOrEqual(15);
    expect(data.analyze_ms).toBeGreaterThanOrEqual(30);
    expect(data.embed_ms).toBeGreaterThanOrEqual(8);
    expect(data.sweep_ms).toBe(0);
    expect(data.peak_rss_mb).toBeGreaterThan(0);
    expect(t.summary()).toMatch(/scan .*analyze .*embed .*sweep .*peak RSS \d+MB/);
  });

  it('finish is idempotent and stops the sampler (no pending handle)', async () => {
    const t = createRunTelemetry({ sampleIntervalMs: 10 });
    await t.phase('scan', async () => {});
    const a = t.finish();
    const b = t.finish();
    expect(b).toEqual(a); // frozen — second call returns the same data
  });

  it('phase records duration even when fn throws', async () => {
    const t = createRunTelemetry();
    await expect(t.phase('analyze', async () => { await sleep(15); throw new Error('boom'); }))
      .rejects.toThrow('boom');
    const data = t.finish();
    expect(data.analyze_ms).toBeGreaterThanOrEqual(5);
  });

  it('resolveRssWarnMb: default 2048, env override, invalid falls back', () => {
    const saved = process.env.MCP_RSS_WARN_MB;
    try {
      delete process.env.MCP_RSS_WARN_MB;
      expect(resolveRssWarnMb()).toBe(2048);
      process.env.MCP_RSS_WARN_MB = '512';
      expect(resolveRssWarnMb()).toBe(512);
      process.env.MCP_RSS_WARN_MB = 'nope';
      expect(resolveRssWarnMb()).toBe(2048);
    } finally {
      if (saved === undefined) delete process.env.MCP_RSS_WARN_MB;
      else process.env.MCP_RSS_WARN_MB = saved;
    }
  });
});
