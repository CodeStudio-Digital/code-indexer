import { describe, expect, it, vi } from 'vitest';
import { AsyncOperationRegistry } from '../operations.js';

describe('AsyncOperationRegistry', () => {
  it('emits heartbeats without resetting semantic idle time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    const emitted: Array<{ event: string; payload: { idleMs?: number; signal?: string } }> = [];
    const registry = new AsyncOperationRegistry(((event: string, payload: { idleMs?: number; signal?: string }) => {
      emitted.push({ event, payload });
    }) as never);

    registry.start({ opId: 'tool:1', kind: 'tool', label: 'run_command' });
    vi.advanceTimersByTime(4_000);
    expect(registry.heartbeat('tool:1')).toMatchObject({ idleMs: 4_000, signal: 'heartbeat' });
    vi.advanceTimersByTime(1_000);
    expect(registry.progress('tool:1', { note: 'real output' })).toMatchObject({
      idleMs: 0,
      signal: 'progress',
    });
    expect(emitted.slice(1).map((entry) => entry.payload.signal)).toEqual(['heartbeat', 'progress']);
    vi.useRealTimers();
  });

  it('touches liveness without emitting operation_progress', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const registry = new AsyncOperationRegistry(((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }) as never);

    registry.start({ opId: 'provider:1', kind: 'provider', label: 'test' });
    vi.advanceTimersByTime(2_000);
    const snapshot = registry.touch('provider:1', { phase: 'text_delta' });

    expect(snapshot).toMatchObject({
      opId: 'provider:1',
      phase: 'text_delta',
      elapsedMs: 2_000,
      idleMs: 0,
    });
    expect(emitted.map((entry) => entry.event)).toEqual(['operation_started']);
    vi.useRealTimers();
  });
});
