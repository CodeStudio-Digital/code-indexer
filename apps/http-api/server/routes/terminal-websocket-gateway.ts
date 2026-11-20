import type { HttpRouter } from '@mcp/shared/http/router.js';
import { asCompanySessionId, type CompanySessionId } from '@mcp/session-storage';
import type { Server as HttpServer } from 'node:http';
import { type TerminalUpgradeDeps, type SpawnSpec } from './terminal-websocket-types.js';
import { tryLoadPty, wsModule } from './terminal-pty-loader.js';
import { resolveSandboxSpec, resolveHostSpec, parseUpgradeRequest, isOriginAllowed, writeUpgradeFailure } from './terminal-session-policy.js';
import { handleConnection } from './terminal-websocket-session.js';

/**
 * Pre-flight HTTP diagnose. Returns the same gate decision the WS
 * upgrade applies, but as a JSON response — the browser can't read
 * the HTTP status of a rejected WebSocket upgrade (the spec collapses
 * every rejection into close code 1006 with no reason), so the
 * terminal UI calls this endpoint first and surfaces the structured
 * error instead of an opaque "code 1006".
 *
 * Mounted at `GET /api/terminal/diagnose?sessionId=N&target=sandbox|host`.
 */
export function mountTerminalDiagnoseRoute(app: HttpRouter, deps: TerminalUpgradeDeps): void {
  app.get('/api/terminal/diagnose', async (c) => {
    const sessionIdRaw = c.req.query('sessionId') ?? '';
    const targetRaw = c.req.query('target') ?? 'sandbox';
    let sessionId: CompanySessionId;
    try {
      sessionId = asCompanySessionId(sessionIdRaw);
      await deps.sessionStore.ensureCatalog();
    } catch {
      return c.json({ ok: false, code: 400, error: 'sessionId must be a canonical Company session UUID' }, 400);
    }
    if (targetRaw !== 'sandbox' && targetRaw !== 'host') {
      return c.json({ ok: false, code: 400, error: `target must be 'sandbox' or 'host' (got '${targetRaw}')` }, 400);
    }
    if (targetRaw === 'host' && process.env.MCP_HOST_TERMINAL_ENABLED !== '1') {
      return c.json(
        {
          ok: false,
          code: 403,
          error: 'Host terminal is disabled. Set MCP_HOST_TERMINAL_ENABLED=1 in the http-api process env and restart the server.',
          remediation: 'env',
        },
        403,
      );
    }
    if (!tryLoadPty()) {
      return c.json(
        {
          ok: false,
          code: 503,
          error: 'node-pty failed to load on this server. Check the [terminal-ws] warning in the server log.',
          remediation: 'native-dep',
        },
        503,
      );
    }
    const spec = targetRaw === 'sandbox'
      ? resolveSandboxSpec(sessionId, deps)
      : resolveHostSpec(sessionId, deps);
    if ('error' in spec) {
      return c.json(
        {
          ok: false,
          code: spec.status,
          error: spec.error,
          remediation: spec.status === 404 ? 'open-session' : spec.status === 409 ? 'provision' : null,
        },
        spec.status as 400 | 404 | 409 | 500,
      );
    }
    return c.json({ ok: true, target: targetRaw, label: spec.label });
  });
}

/**
 * Attach the terminal-WS upgrade listener to the HTTP server. Mirrors
 * the pattern used by `attachCompanyStreamUpgrade`: `noServer: true` so
 * we share the same `upgrade` event with other listeners.
 */
export function attachTerminalUpgrade(server: HttpServer, deps: TerminalUpgradeDeps): void {
  const wss = new wsModule.WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const ctx = parseUpgradeRequest(req);
    if (!ctx) return;
    if (!isOriginAllowed(req)) {
      writeUpgradeFailure(socket, 403, 'origin not allowed');
      return;
    }
    if (ctx.target === 'host' && process.env.MCP_HOST_TERMINAL_ENABLED !== '1') {
      writeUpgradeFailure(
        socket,
        403,
        'host terminal disabled (set MCP_HOST_TERMINAL_ENABLED=1)',
      );
      return;
    }
    const pty = tryLoadPty();
    if (!pty) {
      writeUpgradeFailure(socket, 503, 'node-pty unavailable on this platform');
      return;
    }
    try {
      await deps.sessionStore.ensureCatalog();
    } catch {
      writeUpgradeFailure(socket, 503, 'filesystem session catalog unavailable');
      return;
    }

    // Resolve the spawn shape BEFORE upgrading so a misconfigured
    // session fails fast with a meaningful HTTP error instead of a
    // mid-WebSocket close code.
    let spec: SpawnSpec | { error: string; status: number };
    if (ctx.target === 'sandbox') {
      spec = resolveSandboxSpec(ctx.sessionId, deps);
    } else {
      spec = resolveHostSpec(ctx.sessionId, deps);
    }
    if ('error' in spec) {
      writeUpgradeFailure(socket, spec.status, spec.error);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, ctx, pty, spec as SpawnSpec);
    });
  });
}
