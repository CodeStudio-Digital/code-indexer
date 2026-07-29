/**
 * Verifies openStream stamps a STABLE client_msg_id on POST bodies across a
 * ReconnectingSSEClient reconnect (the client half of the idempotency fix), and
 * leaves GET (/attach) untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStream, type OpenStreamDeps } from '../openStream.js';

const enc = new TextEncoder();
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function sseDone(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode('event: done\ndata: {}\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function deps(): OpenStreamDeps {
  return {
    updateSession: vi.fn(),
    abortMap: new Map(),
    lastSeenSeqMap: new Map(),
    lastSeenBusIdMap: new Map(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // openStream batches flushes via rAF — run the callback synchronously.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('openStream idempotency key', () => {
  it('re-sends an identical, non-empty client_msg_id after a reconnect', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      n++;
      bodies.push(JSON.parse(init.body as string));
      if (n === 1) throw new TypeError('network down'); // drop → triggers backoff retry
      return sseDone();
    }));

    const p = openStream(SESSION_ID, {
      url: `/api/coder/sessions/${SESSION_ID}/messages`,
      method: 'POST',
      body: { content: 'hi' },
    }, deps());
    // First fetch rejected → ReconnectingSSEClient is in its 1s backoff.
    await vi.advanceTimersByTimeAsync(1100);
    await p;

    expect(n).toBe(2);
    expect(typeof bodies[0].client_msg_id).toBe('string');
    expect(bodies[0].client_msg_id).not.toBe('');
    expect(bodies[1].client_msg_id).toBe(bodies[0].client_msg_id); // stable across retry
    expect(bodies[0].content).toBe('hi');
  });

  it('does not add a body/key to GET (/attach)', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      inits.push(init);
      return sseDone();
    }));

    const p = openStream(SESSION_ID, {
      url: `/api/coder/sessions/${SESSION_ID}/attach`,
      method: 'GET',
      reattach: true,
    }, deps());
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(inits[0].body).toBeUndefined();
  });
});
