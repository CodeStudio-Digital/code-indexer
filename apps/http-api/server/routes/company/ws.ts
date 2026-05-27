/**
 * Company-session WebSocket gateway (P14).
 *
 * Parallel transport that mirrors the SSE stream — same events, same
 * envelopes, same `Last-Event-ID` replay semantics — over a single
 * bidirectional connection. SSE remains the default; this route is
 * opt-in via the dashboard's `?transport=ws` query parameter so we
 * can ship both side-by-side and deprecate SSE in a later release.
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

// Narrow `ws` surface — typed locally because `@types/ws` is not a
// project dependency. The runtime module is the published `ws`
// package (`node_modules/ws`).
interface WsLike {
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

interface WsContext {
  sessionId: number;
  sinceSeq: number;
}

const HEARTBEAT_INTERVAL_MS = 25_000;
const PATH_RE = /^\/api\/company\/sessions\/(\d+)\/ws(?:\?(.*))?$/;

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

function parseUpgradeRequest(req: IncomingMessage): WsContext | null {
  if (req.method !== 'GET') return null;
  const url = req.url ?? '';
  const m = PATH_RE.exec(url);
  if (!m) return null;
  const sessionId = Number(m[1]);
  if (!Number.isFinite(sessionId)) return null;
  let sinceSeq = -1;
  if (m[2]) {
    const params = new URLSearchParams(m[2]);
    const raw = params.get('sinceSeq');
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n)) sinceSeq = n;
    }
  }
  return { sessionId, sinceSeq };
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

function handleConnection(
  ws: WsLike,
  ctx: WsContext,
  bus: Parameters<typeof subscribe>[0],
): void {
  // Heartbeat — keeps proxies/load balancers from idling out the
  // connection AND lets the server detect a half-open client quickly
  // via the missing pong response.
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.ping();
      ws.send(JSON.stringify({ v: 1, type: 'ping' }));
    } catch {
      /* connection broken; cleanup happens on `close` */
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
    (heartbeat as { unref: () => void }).unref();
  }

  // Sequential write queue so backpressure during a burst doesn't
  // interleave frames or drop any. `ws.send` is async via the
  // socket buffer; chaining sends keeps order.
  let drainChain: Promise<void> = Promise.resolve();
  const enqueueSend = (frame: string): void => {
    drainChain = drainChain.then(
      () => new Promise<void>((resolve) => {
        if (ws.readyState !== ws.OPEN) return resolve();
        ws.send(frame, (err) => {
          if (err) {
            try { ws.close(1011, 'send failed'); } catch { /* best-effort */ }
          }
          resolve();
        });
      }),
    );
  };

  const unsubscribe = subscribe(
    bus,
    (ev) => {
      enqueueSend(JSON.stringify({ v: 1, seq: ev.seq, type: ev.event, data: ev.data }));
    },
    ctx.sinceSeq,
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
  };

  ws.on('close', cleanup);
  ws.on('error', () => {
    cleanup();
    try { ws.close(1011, 'error'); } catch { /* best-effort */ }
  });

  // Notify the bus end → emit a final close. Don't await — the
  // `close` listener already wires cleanup if the client drops first.
  void waitEnded(bus, makeAbortFromWs(ws)).then(() => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try { ws.close(1000, 'stream ended'); } catch { /* best-effort */ }
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
