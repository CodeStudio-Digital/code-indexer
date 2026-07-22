/**
 * Pure SSE framer tests — parsing contract plus the new `onError`
 * diagnostics for malformed blocks (W14). Comment-only keepalives and
 * field-only blocks (`retry:`) must stay silent; garbage blocks with real
 * content but no recognizable field are reported (and truncated).
 */
import { describe, it, expect, vi } from 'vitest';
import { parseSSEChunk, type SSEFrameError } from '../SSEFramer.js';

describe('SSEFramer parsing contract (unchanged)', () => {
  it('parses id/event/data blocks', () => {
    const { events, rest } = parseSSEChunk('id: 3\nevent: text\ndata: {"a":1}\n\n');
    expect(events).toEqual([{ id: 3, event: 'text', data: '{"a":1}' }]);
    expect(rest).toBe('');
  });

  it('concatenates multi-line data with newlines', () => {
    const { events } = parseSSEChunk('data: line1\ndata: line2\n\n');
    expect(events[0]?.data).toBe('line1\nline2');
  });

  it('keeps the incomplete trailing block in rest', () => {
    const { events, rest } = parseSSEChunk('event: a\ndata: {}\n\nevent: b\ndata: {');
    expect(events).toHaveLength(1);
    expect(rest).toBe('event: b\ndata: {');
  });

  it('defaults the event name to "message" per spec', () => {
    const { events } = parseSSEChunk('data: {}\n\n');
    expect(events[0]?.event).toBe('message');
  });
});

describe('SSEFramer onError diagnostics', () => {
  it('drops comment-only keepalive blocks silently', () => {
    const onError = vi.fn();
    const { events } = parseSSEChunk(': ping\n\nevent: a\ndata: {}\n\n', onError);
    expect(events).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('drops retry-only blocks silently (spec-shaped, undispatched)', () => {
    const onError = vi.fn();
    const { events } = parseSSEChunk('retry: 3000\n\nevent: a\ndata: {}\n\n', onError);
    expect(events.map((e) => e.event)).toEqual(['a']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports garbage blocks via onError and keeps parsing valid events', () => {
    const errors: SSEFrameError[] = [];
    const { events } = parseSSEChunk(
      'garbage line without colon\n\nevent: ok\ndata: {}\n\n',
      (e) => errors.push(e),
    );
    expect(events.map((e) => e.event)).toEqual(['ok']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('malformed_block');
    expect(errors[0]?.raw).toContain('garbage line');
  });

  it('truncates very long malformed blocks in the diagnostic', () => {
    const errors: SSEFrameError[] = [];
    parseSSEChunk(`${'x'.repeat(500)}\n\n`, (e) => errors.push(e));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.raw.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
  });

  it('stays silent by default (no onError supplied)', () => {
    // Must not throw and must not report anywhere.
    const { events } = parseSSEChunk('garbage line\n\nevent: ok\ndata: {}\n\n');
    expect(events.map((e) => e.event)).toEqual(['ok']);
  });
});
