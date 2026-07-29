import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { asCompanySessionId } from '@mcp/session-storage';
import { createBus, markEnded, publish } from '../../../../coder-bus.js';
import {
  handleConnection,
  parseUpgradeRequest,
  type WsContext,
  type WsLike,
} from '../ws.js';

const SESSION_ID = asCompanySessionId(
  '00000000-0000-4000-8000-000000000007',
);
const BOARD_ENTRY_ID = 'b0000000-0000-4000-8000-000000000001';

class FakeWs implements WsLike {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = this.OPEN;
  readonly frames: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  private readonly onceListeners = new Map<string, Array<(...args: never[]) => void>>();

  send(data: string, cb?: (err?: Error) => void): void {
    this.frames.push(data);
    cb?.();
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit('close');
  }

  ping(): void {}

  on(event: 'message', listener: (data: string | Buffer) => void): void;
  on(event: 'close' | 'error', listener: (err?: Error) => void): void;
  on(event: string, listener: (...args: never[]) => void): void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
  }

  once(event: 'close', listener: () => void): void {
    const bucket = this.onceListeners.get(event) ?? [];
    bucket.push(listener);
    this.onceListeners.set(event, bucket);
  }

  private emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
    const once = this.onceListeners.get(event) ?? [];
    this.onceListeners.delete(event);
    for (const listener of once) listener();
  }
}

function context(busId: string | null, sinceSeq = -1): WsContext {
  return { sessionId: SESSION_ID, sinceSeq, busId };
}

async function parsedFrames(ws: FakeWs): Promise<Array<Record<string, unknown>>> {
  await vi.waitFor(() => expect(ws.closes).toHaveLength(1));
  return ws.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

describe('Company WebSocket stream protocol', () => {
  it('decodes the paired replay cursor from the upgrade URL', () => {
    const parsed = parseUpgradeRequest({
      method: 'GET',
      url:
        `/api/company/sessions/${SESSION_ID}/ws?sinceSeq=42&busId=bus%20%2F%2042`,
    } as IncomingMessage);
    expect(parsed).toEqual({
      sessionId: SESSION_ID,
      sinceSeq: 42,
      busId: 'bus / 42',
    });
  });

  it('sends bus_info and an explicit terminal for an already-ended bus', async () => {
    const bus = createBus(new AbortController());
    publish(bus, 'board_entry', { id: BOARD_ENTRY_ID });
    markEnded(bus, 'done', { reason: 'completed' });
    const ws = new FakeWs();

    handleConnection(ws, context(null), bus);
    const frames = await parsedFrames(ws);

    expect(frames.map((frame) => frame.type)).toEqual([
      'bus_info',
      'board_entry',
      'done',
    ]);
    expect(ws.closes[0]).toEqual({ code: 1000, reason: 'stream ended' });
  });

  it('does not duplicate an already-published terminal frame', async () => {
    const bus = createBus(new AbortController());
    publish(bus, 'done', { reason: 'completed' });
    markEnded(bus, 'done', { reason: 'completed' });
    const ws = new FakeWs();

    handleConnection(ws, context(null), bus);
    const frames = await parsedFrames(ws);

    expect(frames.filter((frame) => frame.type === 'done')).toHaveLength(1);
  });

  it('full-replays a mismatched bus but resumes a matching bus cursor', async () => {
    const bus = createBus(new AbortController());
    publish(bus, 'agent_status', { ordinal: 0 });
    publish(bus, 'agent_status', { ordinal: 1 });
    markEnded(bus, 'done', {});

    const staleWs = new FakeWs();
    handleConnection(staleWs, context('previous-bus', 0), bus);
    const staleFrames = await parsedFrames(staleWs);
    expect(staleFrames.filter((frame) => frame.type === 'agent_status').map((frame) => frame.seq))
      .toEqual([0, 1]);

    const currentWs = new FakeWs();
    handleConnection(currentWs, context(bus.busId, 0), bus);
    const currentFrames = await parsedFrames(currentWs);
    expect(currentFrames.filter((frame) => frame.type === 'agent_status').map((frame) => frame.seq))
      .toEqual([1]);
  });
});
