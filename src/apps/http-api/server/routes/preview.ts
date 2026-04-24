/**
 * Preview proxy — forwards browser requests for
 *   `/preview/:sessionId/<path>`
 * to the ephemeral dev-server running inside the sandbox container at
 *   `127.0.0.1:<sandbox.hostPort>/<path>`.
 *
 * HTTP requests are handled inline by Hono via `fetch`. WebSocket upgrades
 * (Vite HMR uses them) are handled by `attachPreviewUpgrade()`, which
 * installs an `upgrade` listener on the underlying Node `http.Server`
 * returned by `@hono/node-server`'s `serve()`.
 *
 * Security posture (MVP):
 *   - The sandbox binds `127.0.0.1:hostPort` only. External clients can
 *     NEVER reach the container directly — they must go through this
 *     proxy, so any future auth gate here (Phase 5) is enforced.
 *   - Requests to `/preview/:id/*` for a session that is not in builder
 *     mode (no sandbox registered) return 404. No information leak about
 *     other sessions.
 */

import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { getSandboxManager } from '../../../../core/sandbox/index.js';
import { getLocalProcessManager } from '../../../../core/sandbox/local-process/LocalProcessManager.js';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { verifyPreviewToken } from './preview-auth.js';

/**
 * Unified binding lookup for the preview proxy. A session can be backed
 * by either a container (Podman/Docker sandbox) OR a host process
 * (local-project). Both expose `127.0.0.1:<hostPort>` on the loopback,
 * so the proxy itself is identical once we know the port.
 *
 * Container lookups win when both are present — shouldn't happen in
 * practice (the `/local-project` route returns 409 when a local run
 * already exists), but containers are the older path and their preview
 * url is already the canonical one for builder-mode sessions.
 */
interface PreviewBinding {
  hostPort: number;
  /** Bump the idle timer / last-access timestamp for TTL purposes. */
  touch(): void;
  /** Source of the binding. Used only for diagnostic logs. */
  kind: 'container' | 'local-process';
}

function resolveBindingForPreview(sessionId: string): PreviewBinding | null {
  const sandbox = getSandboxManager().get(sessionId);
  if (sandbox && sandbox.status === 'ready') {
    return {
      hostPort: sandbox.hostPort,
      touch: () => getSandboxManager().touch(sessionId),
      kind: 'container',
    };
  }
  const local = getLocalProcessManager().get(sessionId);
  if (local && local.status === 'running') {
    return {
      hostPort: local.hostPort,
      // Local processes have no TTL today, but call the noop so the
      // interface stays uniform if we add one later.
      touch: () => {
        local.lastAccessAt = Date.now();
      },
      kind: 'local-process',
    };
  }
  return null;
}

const PREVIEW_PATH_RE = /^\/preview\/([^/]+)(\/.*)?$/;

/**
 * Per-session cooldown so repeated failed fetches don't spawn a storm
 * of dev-server restarts. 30s is long enough for `restartDevServer`
 * to complete (kill + rewrite config + relaunch + port poll) but
 * short enough that a genuinely stuck sandbox recovers within one
 * user-visible reload cycle.
 */
const RESTART_COOLDOWN_MS = 30_000;
const lastRestartAttempt = new Map<string, number>();

function maybeTriggerBackgroundRestart(sessionId: string): boolean {
  const now = Date.now();
  const last = lastRestartAttempt.get(sessionId) ?? 0;
  if (now - last < RESTART_COOLDOWN_MS) return false;
  lastRestartAttempt.set(sessionId, now);
  // Fire-and-forget — the HTTP response is returned immediately with
  // the existing 502 so the user isn't blocked on a 30s+ restart.
  // The next reload (or dashboard poll) picks up the recovered state.
  void getSandboxManager()
    .restartDevServer(sessionId)
    .then(() => {
      console.log(
        `[preview] background dev-server restart succeeded for session=${sessionId}`,
      );
    })
    .catch((err) => {
      console.warn(
        `[preview] background dev-server restart failed for session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  return true;
}

export function mountPreviewRoutes(app: Hono, _deps: ServerDeps): void {
  // ─── Secondary-service preview ──────────────────────────────────
  //
  // Declared BEFORE the generic `/preview/:sessionId/*` so Hono's
  // first-match semantics pick this route up when the URL carries
  // the `_svc` sentinel segment. Scheme:
  //   /preview/<sessionId>/_svc/<serviceId>/<path>
  //
  // Auth: the same HMAC cookie that gates the primary preview (bound
  // to `<sessionId>`, cookie Path=/preview/) covers this route — once
  // you have access to a session you have access to its services.
  //
  // Forwarding rules per stack:
  //   - `cf-worker`: wrangler serves at root (`/`, `/health`, …); the
  //     proxy strips the `/preview/<sessionId>/_svc/<serviceId>` prefix
  //     before forwarding so the Hono routes match.
  //   - Everything else (vite-api, a future frontend-as-service): the
  //     scaffolder already wrote `base = /preview/.../_svc/.../` into
  //     vite.config.ts, so Vite expects the FULL path — prefix is kept.
  app.all('/preview/:sessionId/_svc/:serviceId/*', async (c) => {
    const sessionId = c.req.param('sessionId');
    const serviceId = c.req.param('serviceId');
    if (!verifyPreviewToken(c.req.header('cookie'), sessionId)) {
      return c.json({ error: 'preview token missing or invalid' }, 401);
    }
    const service = getSandboxManager().getService(sessionId, serviceId);
    if (!service || service.status !== 'ready') {
      return c.json(
        { error: `No ready service '${serviceId}' for session ${sessionId}` },
        service ? 409 : 404,
      );
    }
    getSandboxManager().touch(sessionId);

    const url = new URL(c.req.url);
    const prefix = `/preview/${encodeURIComponent(sessionId)}/_svc/${encodeURIComponent(serviceId)}`;
    const stripPrefix = service.stack === 'cf-worker';
    let forwardPath = url.pathname;
    if (stripPrefix && forwardPath.startsWith(prefix)) {
      forwardPath = forwardPath.slice(prefix.length) || '/';
    }
    const targetUrl = `http://127.0.0.1:${service.hostPort}${forwardPath}${url.search}`;

    const headers = new Headers(c.req.raw.headers);
    headers.delete('host');
    headers.delete('connection');
    headers.set('x-forwarded-prefix', prefix);

    try {
      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body: c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : c.req.raw.body,
        // @ts-expect-error — runtime flag not in TS lib
        duplex: 'half',
        redirect: 'manual',
      });
      // Node's fetch auto-decompresses the response body but leaves
      // `content-encoding` in the headers pointing at the ORIGINAL
      // compression (e.g. gzip). If we forward those headers the
      // browser tries to gunzip already-plain bytes and renders blank.
      // `content-length` is invalid for the same reason. Strip both
      // so the browser treats the body as-is. (Miniflare/workerd
      // emits gzip for small JSON responses, which is why the
      // cf-worker preview came back empty.)
      const forwardHeaders = new Headers(upstream.headers);
      forwardHeaders.delete('content-encoding');
      forwardHeaders.delete('content-length');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: forwardHeaders,
      });
    } catch (e) {
      const baseError = e instanceof Error ? e.message : String(e);
      return c.json(
        {
          error: `Preview upstream unreachable: ${baseError}`,
          hint: `Check the service's dev-server log in the Preview → "View dev-server logs" overlay, or via the read_sandbox_logs agent tool.`,
        },
        502,
      );
    }
  });

  // `*` matches any suffix path; the regex above splits sessionId vs.
  // forwarded path so we keep one canonical handler for every verb.
  app.all('/preview/:sessionId/*', async (c) => {
    const sessionId = c.req.param('sessionId');
    // HMAC-cookie gate. Without this, any origin that can reach the API
    // could iframe the sandbox by guessing session IDs. The dashboard
    // gets the cookie from `/api/company/sessions/:id/sandbox` on every
    // poll (see sessions.ts); first-time loads hit this branch until
    // the dashboard's hook has minted one.
    if (!verifyPreviewToken(c.req.header('cookie'), sessionId)) {
      return c.json({ error: 'preview token missing or invalid' }, 401);
    }
    const binding = resolveBindingForPreview(sessionId);
    if (!binding) {
      // No ready container AND no running local-process. Distinguish
      // between "nothing provisioned" (404) and "exists but not ready
      // yet" (409) by consulting the sandbox manager once more.
      const sandbox = getSandboxManager().get(sessionId);
      return c.json(
        { error: `No ready sandbox for session ${sessionId}` },
        sandbox ? 409 : 404,
      );
    }
    // Refresh the idle timer — a live preview counts as activity even
    // when the LLM is not writing files.
    binding.touch();

    // Forward the FULL path (including `/preview/:sessionId/`). Vite
    // inside the container is configured with `base: /preview/:id/`,
    // so it expects requests to carry that prefix. If we stripped it,
    // Vite would redirect `/` back to `/preview/:id/`, which goes
    // through the proxy again, which strips, which redirects… = loop.
    // Keeping the prefix keeps Vite's base-path logic happy and asset
    // URLs (`/preview/45/src/main.tsx` etc.) resolve cleanly through
    // the same route.
    const url = new URL(c.req.url);
    const targetUrl = `http://127.0.0.1:${binding.hostPort}${url.pathname}${url.search}`;

    // Strip hop-by-hop headers. Vite doesn't mind extras, but we don't
    // want `host`/`connection` passed through verbatim.
    const headers = new Headers(c.req.raw.headers);
    headers.delete('host');
    headers.delete('connection');
    // Let Vite know the original URL prefix so it can render correct
    // asset URLs when the app uses `import.meta.env.BASE_URL`.
    headers.set('x-forwarded-prefix', `/preview/${encodeURIComponent(sessionId)}`);

    try {
      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body: c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : c.req.raw.body,
        // Node's fetch requires `duplex: 'half'` when a body is streamed.
        // @ts-expect-error — runtime flag not in TS lib
        duplex: 'half',
        redirect: 'manual',
      });
      // Node's fetch auto-decompresses — drop content-encoding /
      // content-length to avoid double-decompression at the browser.
      const forwardHeaders = new Headers(upstream.headers);
      forwardHeaders.delete('content-encoding');
      forwardHeaders.delete('content-length');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: forwardHeaders,
      });
    } catch (e) {
      // Fetch from our own proxy to the container failed. Probe the TCP
      // port directly to give the operator an actionable diagnosis:
      //   - port closed  → Vite died inside the container. Use
      //     "Restart dev-server" to recover without losing the workdir.
      //   - port answers → fetch-specific issue (DNS? undici?). Include
      //     the original error message.
      const listening = await probeTcp(binding.hostPort);
      const baseError = e instanceof Error ? e.message : String(e);
      // Only containers have a workdir-preserving "restart dev-server"
      // path today. Local processes either recover on their own or the
      // user stops/starts them manually.
      const triggeredRestart =
        !listening &&
        binding.kind === 'container' &&
        maybeTriggerBackgroundRestart(sessionId);
      const hint = listening
        ? `Port ${binding.hostPort} accepts connections but HTTP fetch failed. ` +
          `Usually an HMR-during-restart glitch — reload in a few seconds.`
        : triggeredRestart
          ? `Port ${binding.hostPort} is not accepting connections. Dev-server ` +
            `restart has been triggered automatically (workdir preserved) — ` +
            `retry in a few seconds, or click "Restart dev-server" to force another attempt.`
          : `Port ${binding.hostPort} is not accepting connections. A recovery ` +
            `attempt is already in progress — retry shortly, or click ` +
            `"Restart dev-server" to force another attempt.`;
      return c.json(
        {
          error: `Preview upstream unreachable: ${baseError}`,
          hint,
          portListening: listening,
          restartTriggered: triggeredRestart,
        },
        502,
      );
    }
  });
}

/**
 * Best-effort TCP handshake against the loopback-bound sandbox port.
 * Used purely for diagnostics when the primary fetch call failed —
 * tells the preview route whether Vite is the problem (port closed)
 * or the HTTP layer (port open, request failed).
 */
async function probeTcp(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

/**
 * Wire the WebSocket-upgrade listener onto the Node http.Server returned
 * by `@hono/node-server`'s `serve()`. MUST be called AFTER `serve()`.
 *
 * Implementation: when a client sends `Upgrade: websocket` for
 * `/preview/<sessionId>/<ws-path>`, we open a raw TCP socket to
 * `127.0.0.1:hostPort`, re-emit the HTTP/1.1 request line + headers with
 * the path rewritten, then pipe the two sockets together bidirectionally
 * until either side closes. No third-party proxy lib needed — Vite's
 * HMR is vanilla WebSocket, no sticky state between connections.
 */
export function attachPreviewUpgrade(server: HttpServer): void {
  server.on('upgrade', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const url = req.url ?? '';
    const match = url.match(PREVIEW_PATH_RE);
    if (!match) return; // not a preview upgrade — let other listeners handle it

    const sessionId = decodeURIComponent(match[1]);
    const rest = match[2] ?? '/';
    // Detect the secondary-service sentinel — when the path starts with
    // `/_svc/<serviceId>/...` the upgrade is for that service's dev
    // server, not the primary's. Pick the right sandbox handle so the
    // HMR WebSocket reaches the correct container's port.
    const svcMatch = rest.match(/^\/_svc\/([^/]+)(\/.*)?$/);
    if (!verifyPreviewToken(req.headers.cookie, sessionId)) {
      writeErrorAndClose(clientSocket, 401, 'preview token invalid');
      return;
    }
    const mgr = getSandboxManager();
    // Secondary-service paths (/_svc/<serviceId>) only apply to containers —
    // local-process sessions expose a single primary endpoint.
    const targetSandbox = svcMatch
      ? mgr.getService(sessionId, decodeURIComponent(svcMatch[1]))
      : mgr.get(sessionId);
    let targetPort: number | null = null;
    if (targetSandbox && targetSandbox.status === 'ready') {
      targetPort = targetSandbox.hostPort;
      mgr.touch(sessionId);
    } else if (!svcMatch) {
      // No container, no /_svc sentinel — try the local-process runner.
      const local = getLocalProcessManager().get(sessionId);
      if (local && local.status === 'running') {
        targetPort = local.hostPort;
        local.lastAccessAt = Date.now();
      }
    }
    if (targetPort == null) {
      writeErrorAndClose(clientSocket, 404, 'sandbox not ready');
      return;
    }
    // Preserve the full path on forward — Vite's `base` config inside
    // the container expects the prefix on every request (works for both
    // primary and vite-api service routes). cf-worker doesn't use HMR,
    // so no prefix-stripping needed on this path.
    const forwardPath = url;

    const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
    const onError = (err: Error) => {
      writeErrorAndClose(clientSocket, 502, `upstream error: ${err.message}`);
      upstream.destroy();
    };
    upstream.once('error', onError);

    upstream.once('connect', () => {
      // Re-emit the HTTP/1.1 upgrade request on the upstream socket with
      // the rewritten path. Headers are re-serialized manually to keep
      // casing and order close to what Vite expects.
      const lines: string[] = [];
      lines.push(`${req.method ?? 'GET'} ${forwardPath} HTTP/1.1`);
      const rawHeaders = req.rawHeaders;
      for (let i = 0; i < rawHeaders.length; i += 2) {
        const name = rawHeaders[i];
        const value = rawHeaders[i + 1];
        // Drop the outer `host` — we're addressing 127.0.0.1 now.
        if (name.toLowerCase() === 'host') {
          lines.push(`Host: 127.0.0.1:${targetPort}`);
          continue;
        }
        lines.push(`${name}: ${value}`);
      }
      lines.push('', '');
      upstream.write(lines.join('\r\n'));
      if (head.length) upstream.write(head);

      // Bidirectional pipe. Destroy the partner socket on close/error
      // so neither side leaks.
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      const killBoth = () => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.on('error', killBoth);
      clientSocket.on('error', killBoth);
      upstream.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
    });
  });
}

function writeErrorAndClose(socket: Socket, status: number, reason: string): void {
  const body = `${status} ${reason}`;
  const message =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    `Content-Type: text/plain\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n\r\n${body}`;
  try {
    socket.write(message);
  } catch {
    /* best effort */
  }
  socket.destroy();
}
