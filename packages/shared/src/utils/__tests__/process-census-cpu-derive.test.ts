import { describe, it, expect } from 'vitest';
import { deriveRates } from '../process-census/cpu-derive.js';
import type { CensusFrame, RawProcessRow } from '../process-census/types.js';

const AT = 1_700_000_000_000;

function row(over: Partial<RawProcessRow> & { pid: number }): RawProcessRow {
  return {
    ppid: 1,
    exe: 'node.exe',
    workingSetBytes: 1024,
    cpuTimeMs: 0,
    createdAtMs: AT - 60_000,
    ...over,
  };
}

const frame = (at: number, rows: RawProcessRow[]): CensusFrame =>
  ({ at, rows, commandLines: new Map() });

describe('deriveRates', () => {
  it('turns a CPU-time delta into percent of one core', () => {
    const prev = frame(AT, [row({ pid: 5, cpuTimeMs: 1_000 })]);
    const next = frame(AT + 1_000, [row({ pid: 5, cpuTimeMs: 1_500 })]);
    // 500ms of CPU over 1000ms of wall clock = 50% of one core.
    expect(deriveRates(prev, next, 8).get(5)?.cpuPercent).toBe(50);
  });

  it('lets a multi-threaded process exceed 100% but clamps at 100 x cores', () => {
    const prev = frame(AT, [row({ pid: 5, cpuTimeMs: 0 })]);
    const busy = frame(AT + 1_000, [row({ pid: 5, cpuTimeMs: 3_000 })]);
    expect(deriveRates(prev, busy, 8).get(5)?.cpuPercent).toBe(300);

    const absurd = frame(AT + 1_000, [row({ pid: 5, cpuTimeMs: 99_000 })]);
    expect(deriveRates(prev, absurd, 4).get(5)?.cpuPercent).toBe(400);
  });

  it('reports null (not zero) when there is nothing to compare against', () => {
    const next = frame(AT + 1_000, [row({ pid: 5, cpuTimeMs: 500 })]);
    expect(deriveRates(null, next, 8).get(5)).toEqual({ cpuPercent: null, diskBytesPerSec: null });
  });

  it('reports null for a pid that only appears in the new frame', () => {
    const prev = frame(AT, [row({ pid: 5 })]);
    const next = frame(AT + 1_000, [row({ pid: 5 }), row({ pid: 6, cpuTimeMs: 900 })]);
    expect(deriveRates(prev, next, 8).get(6)?.cpuPercent).toBeNull();
  });

  it('detects PID reuse via the start timestamp', () => {
    const prev = frame(AT, [row({ pid: 5, cpuTimeMs: 10_000, createdAtMs: AT - 600_000 })]);
    const next = frame(AT + 1_000, [row({ pid: 5, cpuTimeMs: 20, createdAtMs: AT + 500 })]);
    expect(deriveRates(prev, next, 8).get(5)?.cpuPercent).toBeNull();
  });

  it('tolerates the one-second jitter of POSIX elapsed time', () => {
    const prev = frame(AT, [row({ pid: 5, cpuTimeMs: 0, createdAtMs: AT - 60_000 })]);
    const next = frame(AT + 1_000, [row({ pid: 5, cpuTimeMs: 100, createdAtMs: AT - 61_000 })]);
    expect(deriveRates(prev, next, 8).get(5)?.cpuPercent).toBe(10);
  });

  it('reports null when a CPU counter goes backwards', () => {
    const prev = frame(AT, [row({ pid: 5, cpuTimeMs: 5_000 })]);
    const next = frame(AT + 1_000, [row({ pid: 5, cpuTimeMs: 10 })]);
    expect(deriveRates(prev, next, 8).get(5)?.cpuPercent).toBeNull();
  });

  it('never divides by a non-positive wall-clock delta', () => {
    const prev = frame(AT, [row({ pid: 5, cpuTimeMs: 0 })]);
    const same = frame(AT, [row({ pid: 5, cpuTimeMs: 500 })]);
    expect(deriveRates(prev, same, 8).get(5)?.cpuPercent).toBeNull();
    const backwards = frame(AT - 5_000, [row({ pid: 5, cpuTimeMs: 500 })]);
    expect(deriveRates(prev, backwards, 8).get(5)?.cpuPercent).toBeNull();
  });

  it('derives disk throughput from cumulative I/O counters', () => {
    const prev = frame(AT, [row({ pid: 5, readBytes: 1_000, writeBytes: 500 })]);
    const next = frame(AT + 2_000, [row({ pid: 5, readBytes: 3_000, writeBytes: 1_500 })]);
    // (3000+1500) - (1000+500) = 3000 bytes over 2s.
    expect(deriveRates(prev, next, 8).get(5)?.diskBytesPerSec).toBe(1_500);
  });

  it('reports null disk throughput when the platform has no I/O counters', () => {
    const prev = frame(AT, [row({ pid: 5 })]);
    const next = frame(AT + 1_000, [row({ pid: 5 })]);
    expect(deriveRates(prev, next, 8).get(5)?.diskBytesPerSec).toBeNull();
  });
});
