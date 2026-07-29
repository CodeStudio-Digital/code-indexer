/**
 * Company-session WebSocket gateway (P14).
 *
 * Parallel transport that mirrors the SSE stream — same events, same
 * envelopes, same cursor replay semantics — over a single bidirectional
 * connection. The dashboard currently uses SSE exclusively; this separate
 * `/ws` endpoint is available to explicit WS consumers and is not selected by
 * a dashboard `transport` query parameter.
 *
 * Protocol:
 *
 *   - URL: `GET /api/company/sessions/:id/ws?sinceSeq=N` (HTTP Upgrade)
 *   - Outbound text frames: `{ v: 1, seq, type, data }` — exactly the
 *     same shape the SSE pump publishes, JSON-encoded
 *   - Heartbeat: server sends `{ "type": "ping" }` every 25 s; clients
 *     ignore. Browser layer also issues `pong` automatically on the
 *     native control frame.
 *   - Inbound text frames: reserved for P13 migration (the worker
 *     would handle them). For now we only accept `{ "type": "ack" }`
 *     and silently drop unknown payloads — never echo, never crash.
 *
 * The implementation uses `ws` (already a transitive dependency) for
 * the protocol parser. Hono only handles standard HTTP; we tap the
 * underlying `node:http.Server` upgrade event directly — same pattern
 * `attachPreviewUpgrade` already uses in this repo.
 *
 * No `@types/ws` is installed in this project, so we declare the
 * narrow surface we need with a minimal ambient interface and import
 * via `createRequire`. Avoids a hard dependency on the typings package.
 */
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { subscribe, waitEnded } from '../../../coder-bus.js';
import { getCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import {
  SerializedWriteQueue,
  streamDrainTimeoutMs,
  streamQueueLimits,
} from '../../../sse/SerializedWriteQueue.js';
import { effectiveSinceForBus } from '../../../sse/pumpBusToSSE.js';
import {
  asCompanySessionId,
  isUuid,
  type CompanySessionId,
} from '@mcp/session-storage';

// Narrow `ws` surface — typed locally because `@types/ws` is not a
// project dependency. The runtime module is the published `ws`
// package (`node_modules/ws`).
export interface WsLike {
  readyState: number;
  readonly OPEN: number;
  readonly CONNECTING: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  on(event: 'message', listener: (data: string | Buffer) => void): void;
  on(event: 'close' | 'error', listener: (err?: Error) => void): void;
  once(event: 'close', listener: () => void): void;
}

interface WebSocketServerLike {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (ws: WsLike) => void,
  ): void;
}

const require = createRequire(import.meta.url);
const wsModule = require('ws') as {
  WebSocketServer: new (opts: { noServer: boolean }) => WebSocketServerLike;
};

export interface WsContext {
  sessionId: CompanySessionId;
  sinceSeq: number;
  busId: string | null;
}

const HEARTBEAT_INTERVAL_MS = 25_000;
const PATH_RE =
  /^\/api\/company\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/ws(?:\?(.*))?$/i;

/**
 * Wire a `WebSocketServer` to the existing HTTP server. Mirrors
 * `attachPreviewUpgrade` — called once from `startServer` after
 * `serve()` returns the node `Server` instance.
 *
 * `noServer: true` mode lets us multiplex: the same HTTP server
 * handles SSE, REST, AND the preview upgrade. We inspect `req.url`
 * and only consume the upgrade event when the path matches; other
 * paths fall through to other listeners (`attachPreviewUpgrade`).
 */
export function attachCompanyStreamUpgrade(server: HttpServer): void {
  const wss = new wsModule.WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const ctx = parseUpgradeRequest(req);
    if (!ctx) return; // not ours — let other listeners handle it
    const orchestrator = getCompanyOrchestrator(ctx.sessionId);
    if (!orchestrator) {
      writeUpgradeFailure(socket, 404, 'session not found');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, ctx, orchestrator.metaBus);
    });
  });
}

export function parseUpgradeRequest(req: IncomingMessage): WsContext | null {
  if (req.method !== 'GET') return null;
  const url = req.url ?? '';
  const m = PATH_RE.exec(url);
  if (!m) return null;
  if (!isUuid(m[1])) return null;
  const sessionId = asCompanySessionId(m[1]);
  let sinceSeq = -1;
  let busId: string | null = null;
  if (m[2]) {
    const params = new URLSearchParams(m[2]);
    const raw = params.get('sinceSeq');
    if (raw != null) {
      if (/^(0|[1-9][0-9]*)$/.test(raw)) {
        const n = Number(raw);
        if (Number.isSafeInteger(n)) sinceSeq = n;
      }
    }
    const rawBusId = params.get('busId')?.trim();
    if (rawBusId && rawBusId.length <= 256) busId = rawBusId;
  }
  return { sessionId, sinceSeq, busId };
}

function writeUpgradeFailure(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n' +
        '\r\n',
    );
    socket.destroy();
  } catch {
    /* socket already closed */
  }
}

export function handleConnection(
  ws: WsLike,
  ctx: WsContext,
  bus: Parameters<typeof subscribe>[0],
): void {
  let unsubscribe = (): void => undefined;

  const sendQueue = new SerializedWriteQueue<string>(
    (frame) => new Promise<void>((resolve, reject) => {
      if (ws.readyState !== ws.OPEN) return resolve();
      ws.send(frame, (err) => err ? reject(err) : resolve());
    }),
    {
      ...streamQueueLimits(),
      onOverflow: () => {
        // Stop this subscriber immediately; the company bus remains alive and
        // the client can reconnect with its last consumed `sinceSeq`.
        try { unsubscribe(); } catch { /* best-effort */ }
        try { ws.close(1013, 'slow consumer'); } catch { /* best-effort */ }
      },
      onWriteError: () => {
        try { ws.close(1011, 'send failed'); } catch { /* best-effort */ }
      },
    },
  );

  const enqueueSend = (frame: string): void => {
    void sendQueue.enqueue(frame, Buffer.byteLength(frame, 'utf8'))
      .catch(() => undefined);
  };

  const sinceSeq = effectiveSinceForBus(
    ctx.sinceSeq,
    bus.nextSeq,
    ctx.busId,
    bus.busId,
  );
  enqueueSend(JSON.stringify({
    v: 1,
    type: 'bus_info',
    data: {
      bus_id: bus.busId,
      first_replay_seq: bus.buffer.find((event) => event.seq > sinceSeq)?.seq ?? bus.nextSeq,
      dropped_replay_events: bus.droppedBufferEvents ?? 0,
    },
  }));

  // Heartbeat — keeps proxies/load balancers from idling out the
  // connection AND lets the server detect a half-open client quickly
  // via the missing pong response.
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      // Native ping is a WebSocket control frame and intentionally bypasses
      // the application-data queue; the textual heartbeat below does not.
      ws.ping();
      // The text heartbeat shares the same serialized, bounded path as data.
      enqueueSend(JSON.stringify({ v: 1, type: 'ping' }));
    } catch {
      /* connection broken; cleanup happens on `close` */
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
    (heartbeat as { unref: () => void }).unref();
  }

  let terminalEnqueued = false;
  unsubscribe = subscribe(
    bus,
    (ev) => {
      if (ev.event === 'done' || ev.event === 'error') terminalEnqueued = true;
      enqueueSend(JSON.stringify({ v: 1, seq: ev.seq, type: ev.event, data: ev.data }));
    },
    sinceSeq,
  );

  ws.on('message', (raw: string | Buffer) => {
    // P14 ships read-only. Future P13 work will route user messages
    // through here (eliminating the REST POST round-trip). For now
    // we tolerate `{ "type": "ack" }` keepalives from the client and
    // ignore anything else — never crash on garbage input.
    try {
      const text = typeof raw === 'string' ? raw : raw.toString();
      const parsed = JSON.parse(text) as { type?: string };
      if (parsed.type === 'ack') return;
    } catch {
      /* unknown frame — silently drop */
    }
  });

  const cleanup = (): void => {
    clearInterval(heartbeat);
    try { unsubscribe(); } catch { /* best-effort */ }
    sendQueue.stop();
  };

  ws.on('close', cleanup);
  ws.on('error', () => {
    cleanup();
    try { ws.close(1011, 'error'); } catch { /* best-effort */ }
  });

  // Notify the bus end → emit a final close. Don't await — the
  // `close` listener already wires cleanup if the client drops first.
  void waitEnded(bus, makeAbortFromWs(ws)).then(async () => {
    // Freeze the queue before taking its drain snapshot. Otherwise a heartbeat
    // tick could append behind the terminal event while waitForIdle is active.
    clearInterval(heartbeat);
    try { unsubscribe(); } catch { /* best-effort */ }
    if (
      bus.endReason
      && !terminalEnqueued
      && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)
    ) {
      terminalEnqueued = true;
      enqueueSend(JSON.stringify({
        v: 1,
        type: bus.endReason.event,
        data: bus.endReason.data ?? {},
      }));
    }
    const drained = await sendQueue.waitForIdle(streamDrainTimeoutMs());
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        ws.close(
          drained ? 1000 : 1011,
          drained ? 'stream ended' : 'terminal drain timed out',
        );
      } catch { /* best-effort */ }
    }
  }).catch(() => undefined);
}

/**
 * Bridge: turn a `ws.WebSocket` close event into an `AbortSignal` for
 * `waitEnded(bus, signal)`. When the client disconnects before the
 * bus emits its terminal event we want the wait to unblock so the
 * cleanup path runs promptly.
 */
function makeAbortFromWs(ws: WsLike): AbortSignal {
  const ac = new AbortController();
  ws.once('close', () => ac.abort());
  return ac.signal;
}
