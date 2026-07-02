/**
 * Pure tests for the live service-log buffer (company B6) — the append
 * logic behind `sandboxSlice.sandboxAppendServiceLogs`, fed by the
 * `sandbox.service.log_batch` stream handler in useCompanyStream.
 */
import { describe, expect, it } from 'vitest';
import {
  appendServiceLogLines,
  SERVICE_LOG_BUFFER_CAP,
  type ServiceLogEntry,
} from '../company/service-log-buffer.js';

describe('appendServiceLogLines', () => {
  it('appends with a continuing per-service sequence', () => {
    const first = appendServiceLogLines(undefined, [
      { atMs: 1, stream: 'devserver', line: 'a' },
      { atMs: 2, stream: 'container', line: 'b' },
    ]);
    expect(first.map((e) => [e.seq, e.line])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    const second = appendServiceLogLines(first, [{ atMs: 3, stream: 'devserver', line: 'c' }]);
    expect(second.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('normalizes malformed SSE payload entries defensively', () => {
    const rows = appendServiceLogLines(undefined, [
      { line: 'no-meta' }, // missing atMs/stream
      { atMs: Number.NaN, stream: '', line: 'weird' },
      { atMs: 5, stream: 'devserver', line: '   ' }, // blank → dropped
      {}, // no line → dropped
    ]);
    expect(rows.map((e) => e.line)).toEqual(['no-meta', 'weird']);
    expect(rows.every((e) => Number.isFinite(e.atMs))).toBe(true);
    expect(rows.every((e) => e.stream !== '')).toBe(true);
  });

  it('keeps only the newest `cap` entries (bounded ring)', () => {
    const batch = Array.from({ length: SERVICE_LOG_BUFFER_CAP + 100 }, (_, i) => ({
      atMs: i,
      stream: 'devserver',
      line: `line-${i}`,
    }));
    const rows = appendServiceLogLines(undefined, batch);
    expect(rows).toHaveLength(SERVICE_LOG_BUFFER_CAP);
    expect(rows[0].line).toBe('line-100'); // oldest 100 evicted
    expect(rows[rows.length - 1].line).toBe(`line-${SERVICE_LOG_BUFFER_CAP + 99}`);
  });

  it('never mutates the previous buffer', () => {
    const prev: ServiceLogEntry[] = [{ seq: 1, atMs: 1, stream: 'devserver', line: 'a' }];
    const frozen = Object.freeze(prev.slice()) as unknown as ServiceLogEntry[];
    const next = appendServiceLogLines(frozen, [{ atMs: 2, stream: 'devserver', line: 'b' }]);
    expect(next).toHaveLength(2);
    expect(frozen).toHaveLength(1);
  });
});
