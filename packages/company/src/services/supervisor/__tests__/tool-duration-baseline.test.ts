/**
 * Tests for ToolDurationBaseline (Sprint 4 Phase 3.4).
 *
 * Locks in:
 *   - recordSuccess feeds the ring; ring caps at ringSize (oldest evicted)
 *   - outlierThresholdMs returns null below minSamples
 *   - outlierThresholdMs returns p90 × factor once we have enough samples
 *   - Invalid durations (NaN, negative) are silently ignored
 *   - Per-tool separation — different tools have separate rings
 *   - getStats / allStats snapshots
 *   - configFromEnv reads MCP_SUPERVISOR_TOOL_* env vars
 *   - Bad env values fall back to defaults
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BASELINE_CONFIG,
  ToolDurationBaseline,
  baselineConfigFromEnv,
  getGlobalToolBaseline,
  setGlobalToolBaselineForTests,
} from '../tool-duration-baseline.js';

describe('recordSuccess + ring buffer', () => {
  it('records durations and caps at ringSize', () => {
    const b = new ToolDurationBaseline({ ringSize: 3, minSamples: 1 });
    b.recordSuccess('Bash', 100);
    b.recordSuccess('Bash', 200);
    b.recordSuccess('Bash', 300);
    b.recordSuccess('Bash', 400); // evicts 100
    const stats = b.getStats('Bash');
    expect(stats.samples).toBe(3);
    // Median of [200, 300, 400]
    expect(stats.p50).toBe(300);
  });

  it('ignores invalid durations', () => {
    const b = new ToolDurationBaseline({ minSamples: 1 });
    b.recordSuccess('Bash', NaN);
    b.recordSuccess('Bash', -1);
    b.recordSuccess('Bash', Infinity);
    expect(b.getStats('Bash').samples).toBe(0);
  });

  it('keeps per-tool counters separate', () => {
    const b = new ToolDurationBaseline({ minSamples: 1 });
    b.recordSuccess('Read', 50);
    b.recordSuccess('Bash', 500);
    expect(b.getStats('Read').samples).toBe(1);
    expect(b.getStats('Bash').samples).toBe(1);
    expect(b.getStats('Read').p50).toBe(50);
    expect(b.getStats('Bash').p50).toBe(500);
  });
});

describe('outlierThresholdMs', () => {
  it('returns null below minSamples', () => {
    const b = new ToolDurationBaseline({ minSamples: 5 });
    for (let i = 0; i < 4; i++) b.recordSuccess('Bash', 100);
    expect(b.outlierThresholdMs('Bash')).toBeNull();
  });

  it('returns p90 × factor at minSamples', () => {
    const b = new ToolDurationBaseline({ minSamples: 5, outlierFactor: 2.0 });
    for (let i = 0; i < 10; i++) b.recordSuccess('Bash', (i + 1) * 100); // 100..1000
    // p90 of [100..1000] = 910 (linear interp between 900 and 1000)
    const t = b.outlierThresholdMs('Bash');
    expect(t).not.toBeNull();
    expect(t).toBeGreaterThan(1700);
    expect(t).toBeLessThan(2000);
  });

  it('returns null for never-seen tools', () => {
    const b = new ToolDurationBaseline({ minSamples: 1 });
    expect(b.outlierThresholdMs('Unknown')).toBeNull();
  });

  it('outlierFactor scales the threshold', () => {
    const b1 = new ToolDurationBaseline({ minSamples: 5, outlierFactor: 1.5 });
    const b2 = new ToolDurationBaseline({ minSamples: 5, outlierFactor: 3.0 });
    for (let i = 0; i < 10; i++) {
      b1.recordSuccess('Bash', 100);
      b2.recordSuccess('Bash', 100);
    }
    const t1 = b1.outlierThresholdMs('Bash')!;
    const t2 = b2.outlierThresholdMs('Bash')!;
    expect(t2).toBe(t1 * 2); // factor doubled → threshold doubled
  });
});

describe('getStats', () => {
  it('returns empty stats for never-seen tool', () => {
    const b = new ToolDurationBaseline();
    expect(b.getStats('Bash')).toEqual({
      toolName: 'Bash',
      samples: 0,
      p50: 0,
      p90: 0,
      p99: 0,
      outlierThresholdMs: null,
    });
  });

  it('reports p50/p90/p99 + sample count', () => {
    const b = new ToolDurationBaseline({ minSamples: 1, ringSize: 100 });
    for (let i = 1; i <= 100; i++) b.recordSuccess('Bash', i * 10);
    const s = b.getStats('Bash');
    expect(s.samples).toBe(100);
    expect(s.p50).toBeGreaterThan(490);
    expect(s.p50).toBeLessThan(520);
    expect(s.p90).toBeGreaterThan(890);
    expect(s.p99).toBeGreaterThan(980);
  });

  it('allStats lists every observed tool', () => {
    const b = new ToolDurationBaseline({ minSamples: 1 });
    b.recordSuccess('Bash', 100);
    b.recordSuccess('Read', 50);
    b.recordSuccess('Edit', 75);
    const all = b.allStats();
    expect(all).toHaveLength(3);
    expect(all.map((s) => s.toolName).sort()).toEqual(['Bash', 'Edit', 'Read']);
  });
});

describe('config', () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('defaults match DEFAULT_BASELINE_CONFIG', () => {
    const b = new ToolDurationBaseline();
    expect(b.getConfig()).toEqual(DEFAULT_BASELINE_CONFIG);
  });

  it('partial overrides merge with defaults', () => {
    const b = new ToolDurationBaseline({ minSamples: 99 });
    expect(b.getConfig().minSamples).toBe(99);
    expect(b.getConfig().ringSize).toBe(DEFAULT_BASELINE_CONFIG.ringSize);
  });

  it('configFromEnv reads MCP_SUPERVISOR_TOOL_* vars', () => {
    process.env.MCP_SUPERVISOR_TOOL_MIN_SAMPLES = '10';
    process.env.MCP_SUPERVISOR_TOOL_OUTLIER_FACTOR = '3.5';
    process.env.MCP_SUPERVISOR_TOOL_BASELINE_RING_SIZE = '200';
    const c = baselineConfigFromEnv();
    expect(c.minSamples).toBe(10);
    expect(c.outlierFactor).toBe(3.5);
    expect(c.ringSize).toBe(200);
  });

  it('bad env values fall back to defaults', () => {
    process.env.MCP_SUPERVISOR_TOOL_MIN_SAMPLES = 'not-a-number';
    process.env.MCP_SUPERVISOR_TOOL_OUTLIER_FACTOR = '-1';
    const c = baselineConfigFromEnv();
    expect(c.minSamples).toBe(DEFAULT_BASELINE_CONFIG.minSamples);
    expect(c.outlierFactor).toBe(DEFAULT_BASELINE_CONFIG.outlierFactor);
  });
});

describe('global singleton', () => {
  beforeEach(() => setGlobalToolBaselineForTests(null));
  afterEach(() => setGlobalToolBaselineForTests(null));

  it('lazy-creates on first access', () => {
    const a = getGlobalToolBaseline();
    const b = getGlobalToolBaseline();
    expect(a).toBe(b);
  });

  it('setGlobalToolBaselineForTests overrides', () => {
    const custom = new ToolDurationBaseline({ minSamples: 1 });
    setGlobalToolBaselineForTests(custom);
    expect(getGlobalToolBaseline()).toBe(custom);
  });
});

describe('clearForTests', () => {
  it('resets all sampled rings', () => {
    const b = new ToolDurationBaseline({ minSamples: 1 });
    b.recordSuccess('Bash', 100);
    b.recordSuccess('Read', 50);
    b.clearForTests();
    expect(b.allStats()).toEqual([]);
  });
});
