/**
 * Smoke tests for the WebSocket-side reconnecting client. Mocks the
 * global `WebSocket` constructor via the `WS_CONSTRUCTOR_FOR_TESTS`
 * symbol the production code reads, so we don't need a real network
 * stack.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReconnectingWebSocketClient, type WebSocketLike } from '../ReconnectingWebSocketClient.js';
import type { SSEEvent } from '../../sse/SSEFramer.js';
import { ExponentialBackoff } from '../../sse/BackoffStrategy.js';

class MockWebSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
    // Defer the "open" callback so tests can assign listeners
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.({});
      }
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Simulate the server pushing a frame. */
  push(frame: object | string): void {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.onmessage?.({ data });
  }
}

function installMock(): void {
  (globalThis as unknown as { WS_CONSTRUCTOR_FOR_TESTS?: typeof MockWebSocket }).WS_CONSTRUCTOR_FOR_TESTS =
    MockWebSocket;
}

function uninstallMock(): void {
  delete (globalThis as unknown as { WS_CONSTRUCTOR_FOR_TESTS?: typeof MockWebSocket }).WS_CONSTRUCTOR_FOR_TESTS;
  MockWebSocket.instances = [];
}

describe('ReconnectingWebSocketClient', () => {
  beforeEach(installMock);
  afterEach(uninstallMock);

  it('translates incoming WS frames to SSEEvent shape and emits live phase', async () => {
    const events: SSEEvent[] = [];
    const phases: string[] = [];
    const ctrl = new AbortController();
    const client = new ReconnectingWebSocketClient({
      url: 'ws://localhost:1/api/company/sessions/1/ws',
      signal: ctrl.signal,
      onEvent: (ev) => events.push(ev),
      onPhase: (phase) => phases.push(phase),
      isTerminal: (ev) => ev.event === 'done',
    });
    const runPromise = client.run();
    // Let the queued microtask open the mock.
    await new Promise((r) => setTimeout(r, 0));
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();
    ws.push({ v: 1, seq: 1, type: 'board_entry', data: { id: 1 } });
    ws.push({ v: 1, type: 'ping' });
    ws.push({ v: 1, seq: 2, type: 'done', data: {} });
    await runPromise;
    expect(events).toEqual([
      { id: 1, event: 'board_entry', data: JSON.stringify({ id: 1 }) },
      { id: 2, event: 'done', data: JSON.stringify({}) },
    ]);
    expect(phases).toContain('connecting');
    expect(phases).toContain('live');
  });

  it('appends sinceSeq when Last-Event-ID equivalent is provided', async () => {
    const ctrl = new AbortController();
    let lastSeen = 42;
    const client = new ReconnectingWebSocketClient({
      url: 'ws://h/api/company/sessions/1/ws',
      signal: ctrl.signal,
      onEvent: () => undefined,
      getLastEventId: () => lastSeen,
      isTerminal: () => true, // first event terminates
    });
    const runPromise = client.run();
    await new Promise((r) => setTimeout(r, 0));
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('ws://h/api/company/sessions/1/ws?sinceSeq=42');
    ws.push({ v: 1, seq: 1, type: 'done', data: {} });
    await runPromise;
    lastSeen = -1; // suppress eslint unused var warning
  });

  it('retries on close with backoff until terminal arrives', async () => {
    const ctrl = new AbortController();
    const events: SSEEvent[] = [];
    const phases: string[] = [];
    const client = new ReconnectingWebSocketClient({
      url: 'ws://h/x',
      signal: ctrl.signal,
      onEvent: (ev) => events.push(ev),
      onPhase: (phase) => phases.push(phase),
      backoff: new ExponentialBackoff({ baseMs: 1, maxMs: 4, maxAttempts: 5 }),
      isTerminal: (ev) => ev.event === 'done',
    });
    const runPromise = client.run();
    // First connection — close abnormally.
    await new Promise((r) => setTimeout(r, 0));
    MockWebSocket.instances[0].close(1006, 'lost');
    // Wait for retry; backoff ~1ms.
    await new Promise((r) => setTimeout(r, 10));
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const second = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    second.push({ v: 1, seq: 5, type: 'done', data: {} });
    await runPromise;
    expect(phases).toContain('disconnected');
    expect(phases).toContain('live');
  });

  it('aborts cleanly via the signal', async () => {
    const ctrl = new AbortController();
    const client = new ReconnectingWebSocketClient({
      url: 'ws://h/x',
      signal: ctrl.signal,
      onEvent: () => undefined,
    });
    const runPromise = client.run();
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort();
    await runPromise; // should resolve, not reject
  });
});
