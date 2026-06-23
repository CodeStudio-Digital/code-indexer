import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalOutputChunk } from '@mcp/api-bus';
import { OutputCoalescer, trimReplayBuffer } from '../output-coalescer.js';

describe('OutputCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches consecutive data chunks within the window into one emit', () => {
    const out: TerminalOutputChunk[] = [];
    const c = new OutputCoalescer((chunk) => out.push(chunk), 16);
    c.push('a');
    c.push('b');
    c.push('c');
    expect(out).toEqual([]);            // nothing emitted yet — still in window
    vi.advanceTimersByTime(16);
    expect(out).toEqual([{ type: 'data', data: 'abc' }]);
  });

  it('starts a fresh window after a flush', () => {
    const out: TerminalOutputChunk[] = [];
    const c = new OutputCoalescer((chunk) => out.push(chunk), 16);
    c.push('a');
    vi.advanceTimersByTime(16);
    c.push('b');
    vi.advanceTimersByTime(16);
    expect(out).toEqual([{ type: 'data', data: 'a' }, { type: 'data', data: 'b' }]);
  });

  it('windowMs<=0 emits every chunk immediately (coalescing disabled)', () => {
    const out: TerminalOutputChunk[] = [];
    const c = new OutputCoalescer((chunk) => out.push(chunk), 0);
    c.push('a');
    c.push('b');
    expect(out).toEqual([{ type: 'data', data: 'a' }, { type: 'data', data: 'b' }]);
  });

  it('flush() drains pending data now and clears the timer (exit ordering)', () => {
    const out: TerminalOutputChunk[] = [];
    const c = new OutputCoalescer((chunk) => out.push(chunk), 16);
    c.push('tail');
    c.flush();
    expect(out).toEqual([{ type: 'data', data: 'tail' }]);
    vi.advanceTimersByTime(16);          // timer was cleared — no duplicate emit
    expect(out).toHaveLength(1);
  });

  it('flush() with nothing pending is a no-op', () => {
    const out: TerminalOutputChunk[] = [];
    const c = new OutputCoalescer((chunk) => out.push(chunk), 16);
    c.flush();
    expect(out).toEqual([]);
  });
});

describe('trimReplayBuffer', () => {
  const data = (s: string): TerminalOutputChunk => ({ type: 'data', data: s });

  it('drops oldest data chunks until under the byte cap', () => {
    const buf = [data('aaaa'), data('bbbb'), data('cccc')]; // 12 bytes
    const bytes = trimReplayBuffer(buf, 12, 8);
    expect(buf).toEqual([data('bbbb'), data('cccc')]);
    expect(bytes).toBe(8);
  });

  it('never trims below the last chunk', () => {
    const buf = [data('aaaa'), data('bbbbbbbb')]; // 12 bytes, cap smaller than last
    trimReplayBuffer(buf, 12, 4);
    expect(buf).toEqual([data('bbbbbbbb')]);
  });

  it('maxBytes<=0 disables trimming', () => {
    const buf = [data('aaaa'), data('bbbb')];
    const bytes = trimReplayBuffer(buf, 8, 0);
    expect(buf).toHaveLength(2);
    expect(bytes).toBe(8);
  });
});
