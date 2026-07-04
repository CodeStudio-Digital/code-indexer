/**
 * Unit tests for ReconnectingSSEClient.
 *
 * Focus: the reconnect contract that the server-side idempotency fix relies on
 * — on a mid-stream drop the client re-sends the FULL POST body (byte-identical)
 * plus a `Last-Event-ID` header. That re-POST is what the server dedupes via
 * `client_msg_id`, so this documents the behaviour the fix depends on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReconnectingSSEClient } from '../ReconnectingSSEClient.js';
import type { SSEEvent } from '../SSEFramer.js';

const enc = new TextEncoder();
const NO_BACKOFF = { nextDelay: () => 0 };

/** A Response whose body streams the given SSE frames then closes gracefully. */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A Response whose body emits the frames one-per-pull, then errors on the next
 * pull (simulates a dropped socket). Pull-based (not enqueue-then-error) so the
 * consumer actually reads the frames before the error surfaces — `error()`
 * discards any still-queued chunks.
 */
function droppingResponse(frames: string[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else controller.error(new Error('network dropped'));
    },
  });
  return new Response(stream, { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe('ReconnectingSSEClient', () => {
  it('resolves on a terminal `done` event with a single fetch', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return sseResponse(['event: text\ndata: {"t":"hi"}\n\n', 'event: done\ndata: {}\n\n']);
    }));
    const events: SSEEvent[] = [];
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'POST',
      body: { content: 'hi' },
      signal: new AbortController().signal,
      onEvent: (ev) => events.push(ev),
      backoff: NO_BACKOFF,
    }).run();

    expect(calls).toBe(1);
    expect(events.map((e) => e.event)).toEqual(['text', 'done']);
  });

  it('re-sends the identical body + a Last-Event-ID header on reconnect', async () => {
    const calls: Array<{ headers: Headers; body: unknown }> = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      n++;
      calls.push({ headers: new Headers(init.headers), body: init.body });
      return n === 1
        ? droppingResponse([
            'id: 0\nevent: text\ndata: {"a":1}\n\n',
            'id: 1\nevent: text\ndata: {"b":2}\n\n',
          ])
        : sseResponse(['id: 2\nevent: done\ndata: {}\n\n']);
    }));

    let lastSeen = -1;
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'POST',
      body: { content: 'hi', client_msg_id: 'key-123' },
      signal: new AbortController().signal,
      onEvent: (ev) => { if (ev.id !== undefined) lastSeen = ev.id; },
      getLastEventId: () => lastSeen,
      backoff: NO_BACKOFF,
    }).run();

    expect(n).toBe(2);
    // Retry replays from the last id the client actually saw.
    expect(calls[0].headers.get('Last-Event-ID')).toBeNull();
    expect(calls[1].headers.get('Last-Event-ID')).toBe('1');
    // The dedup contract: the body (with client_msg_id) is byte-identical on retry.
    expect(calls[1].body).toBe(calls[0].body);
    expect(JSON.parse(calls[0].body as string)).toEqual({ content: 'hi', client_msg_id: 'key-123' });
  });

  it('treats a graceful close with no terminal event as done (no retry)', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return sseResponse(['event: text\ndata: {"t":1}\n\n']);
    }));
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'GET',
      signal: new AbortController().signal,
      onEvent: () => {},
      backoff: NO_BACKOFF,
    }).run();

    expect(n).toBe(1);
  });

  it('throws a nonRetryable error on 4xx without retrying, surfacing status + body', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return new Response(JSON.stringify({ code: 'INTERACTION_PENDING', error: 'waiting' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }));
    await expect(
      new ReconnectingSSEClient({
        url: 'http://x/api',
        method: 'POST',
        body: {},
        signal: new AbortController().signal,
        onEvent: () => {},
        backoff: NO_BACKOFF,
      }).run(),
    ).rejects.toMatchObject({ status: 409, httpBody: { code: 'INTERACTION_PENDING' } });
    expect(n).toBe(1);
  });
});
