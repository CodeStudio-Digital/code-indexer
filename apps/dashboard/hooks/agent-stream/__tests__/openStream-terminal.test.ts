import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStream } from '../openStream.js';
import { __resetAgentStreamStoreForTests, agentStreamAbortMap, agentStreamLastSeenBusIdMap, agentStreamLastSeenSeqMap,
  getActiveAgentSessionIdsSnapshot, getAgentSessionSnapshot, updateAgentSession, forgetAgentSession } from '../session-stream-store.js';
import { __resetWorkerLogForTests } from '../worker-log-store.js';

const sid = '33333333-3333-4333-8333-333333333333';
const enc = new TextEncoder();
afterEach(() => { __resetAgentStreamStoreForTests(); __resetWorkerLogForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('chat terminal activity', () => {
  it.each(['done', 'error'])('clears header and global count on %s despite a hung cancel', async event => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode(`event: message_complete\ndata: {}\n\nevent: ${event}\ndata: {"reason":"${event}"}\n\n`)); },
      cancel: () => new Promise<void>(() => {}),
    }))));
    const pending = openStream(sid, { url: `/api/coder/sessions/${sid}/attach`, method: 'GET', reattach: true }, {
      updateSession: updateAgentSession, abortMap: agentStreamAbortMap,
      lastSeenSeqMap: agentStreamLastSeenSeqMap, lastSeenBusIdMap: agentStreamLastSeenBusIdMap,
    });
    expect(getActiveAgentSessionIdsSnapshot()).toEqual([sid]);
    await vi.advanceTimersByTimeAsync(100);
    expect(getActiveAgentSessionIdsSnapshot()).toEqual([]);
    expect(getAgentSessionSnapshot(sid)).toMatchObject({ streaming: false, doneReason: event, preflight: null });
    expect(agentStreamAbortMap.has(sid)).toBe(false);
    await pending;
  });

  it('forgets a deleted chat without late terminal frames resurrecting it', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode('event: done\ndata: {}\n\n')); },
    }))));
    const pending = openStream(sid, { url: '/api/fixture', method: 'GET' }, {
      updateSession: updateAgentSession, abortMap: agentStreamAbortMap,
      lastSeenSeqMap: agentStreamLastSeenSeqMap, lastSeenBusIdMap: agentStreamLastSeenBusIdMap,
    });
    forgetAgentSession(sid);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(getActiveAgentSessionIdsSnapshot()).toEqual([]);
    expect(getAgentSessionSnapshot(sid)).toMatchObject({ streaming: false, doneReason: null, currentTurn: null });
  });
});
