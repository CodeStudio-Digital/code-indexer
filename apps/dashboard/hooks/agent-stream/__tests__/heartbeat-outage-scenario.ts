import { expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { bootstrapTestI18n } from '../../../i18n/test-bootstrap.js';
import { StuckBanner } from '../../../features/chat/StuckBanner.js';
import { markEnded, publish, type CoderRunBus } from '../../../../http-api/coder-bus.js';
import { openStream } from '../openStream.js';
import { EMPTY_STATE } from '../types.js';

/** Exercise the renderer against the mounted HTTP route and its actual SSE
 * pump. Only the worker boundary and the broken renderer link are simulated. */
export async function exerciseHeartbeatOutage(
  sessionId: string,
  request: (url: string, init: RequestInit) => Promise<Response>,
  getBus: () => CoderRunBus,
): Promise<void> {
  await bootstrapTestI18n();
  await i18n.changeLanguage('pt-BR');
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 1));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const sent: RequestInit[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push(init);
    if (sent.length > 1 && sent.length < 6) throw new TypeError('link down');
    if (sent.length === 6) return new Promise<Response>(() => {});
    const real = await request(url, init);
    if (sent.length !== 1) return real;
    let silent = false;
    return new Response(real.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, output) {
        if (silent) return;
        output.enqueue(bytes);
        if (new TextDecoder().decode(bytes).includes('before-cut')) silent = true;
      },
    })), { headers: real.headers });
  });
  const abortMap = new Map<string, AbortController>();
  const errors: string[] = [];
  let view = { ...EMPTY_STATE };
  const transcript = () => view.currentTurn?.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
  const status = () => renderToStaticMarkup(createElement(StuckBanner, {
    streaming: view.streaming, reconnecting: view.reconnecting, lastEventAt: view.lastEventAt,
  }));
  try {
    const run = openStream(sessionId, {
      url: `/api/coder/sessions/${sessionId}/messages`, method: 'POST', body: { content: 'exercise the link' },
    }, {
      abortMap, lastSeenBusIdMap: new Map(), lastSeenSeqMap: new Map(),
      updateSession: (_sid, patch) => {
        view = { ...view, ...(typeof patch === 'function' ? patch(view) : patch) };
        if (view.error) errors.push(view.error);
      },
    });
    await vi.advanceTimersByTimeAsync(100);

    const bus = getBus();
    const cursor = publish(bus, 'text', { text: 'before-cut' }).seq;
    await vi.advanceTimersByTimeAsync(100);
    expect(transcript()).toBe('before-cut');
    publish(bus, 'text', { text: ' during-outage' });
    await vi.advanceTimersByTimeAsync(122_000);
    expect(sent).toHaveLength(6);
    expect(view).toMatchObject({ streaming: true, reconnecting: true, error: null });
    expect(status()).toContain('Reconectando à conversa');
    expect(transcript()).toBe('before-cut');
    expect(bus.ctrl.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(view).toMatchObject({ streaming: true, reconnecting: false });
    expect(transcript()).toBe('before-cut during-outage');
    publish(bus, 'text', { text: ' after-reconnect' });
    markEnded(bus, 'done', { reason: 'completed' });
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(transcript()).toBe('before-cut during-outage after-reconnect');
    expect(view).toMatchObject({ streaming: false, doneReason: 'completed' });
    expect(status()).toBe('');
    expect(sent).toHaveLength(7);
    expect(new Set(sent.map(req => JSON.parse(String(req.body)).client_msg_id)).size).toBe(1);
    expect(new Headers(sent[6].headers).get('Last-Event-ID')).toBe(String(cursor));
    expect(new Headers(sent[6].headers).get('X-MCP-Bus-ID')).toBe(bus.busId);
    expect(errors).toEqual([]);
  } finally {
    abortMap.get(sessionId)?.abort();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
}
