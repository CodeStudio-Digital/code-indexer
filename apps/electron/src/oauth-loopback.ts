/**
 * Ephemeral 127.0.0.1 loopback listener that captures the OAuth redirect
 * in the desktop app — the RFC 8252 native-app pattern.
 *
 * The dashboard opens the provider's login in the user's real browser; the
 * provider redirects back to
 *   http://127.0.0.1:<port>/api/admin/mcp-servers/:id/oauth/callback
 * which this server forwards to the in-process Hono app for the PKCE token
 * exchange. We need a real socket here precisely because the app's normal
 * backend transport is socket-free (mcp:// in-process) — an external browser
 * can't reach that.
 *
 * Scope is deliberately tiny: the listener exists ONLY during an
 * authorization (started on "Authorize", stopped on completion/cancel, plus
 * a safety auto-stop), binds loopback only, and forwards a SINGLE path —
 * everything else 404s. So the exposure is one route, on 127.0.0.1, for the
 * seconds of the flow.
 */
import type { Hono } from 'hono';

/** Fixed so the DCR-registered redirect_uri matches what we later bind. */
export const OAUTH_LOOPBACK_PORT = 7878;

/** Safety net: never leave the listener up longer than one auth attempt. */
const AUTO_STOP_MS = 10 * 60 * 1000;

/** Only the OAuth callback is forwarded; nothing else is reachable. */
const CALLBACK_PATH = /^\/api\/admin\/mcp-servers\/[^/]+\/oauth\/callback$/;

/** A tiny self-contained page shown after the browser-login handoff lands. */
const RETURN_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>CodeStudio</title></head><body><h2>You are signed in</h2><p>You can close this tab and return to CodeStudio.</p></body></html>';

type LoopbackServer = ReturnType<(typeof import('@hono/node-server'))['serve']>;

let server: LoopbackServer | null = null;
let autoStop: NodeJS.Timeout | null = null;
/** Shared with the running server's fetch closure so either flow (MCP callback or
 *  browser-login /cb) works regardless of which one started the listener. */
let currentHonoApp: Hono | null = null;
let authCapture: ((handoff: string) => void) | null = null;

/** Arm a one-shot capture for the next `/cb?handoff=` hit (browser OAuth login). */
export function registerAuthCapture(cb: (handoff: string) => void): void {
  authCapture = cb;
}
export function clearAuthCapture(): void {
  authCapture = null;
}

export interface LoopbackResult {
  ok: boolean;
  port?: number;
  error?: string;
}

/**
 * Start (or reuse) the loopback listener. Idempotent: calling it again while
 * already running just re-arms the safety timer and returns the port.
 */
export async function startOAuthLoopback(honoApp?: Hono): Promise<LoopbackResult> {
  if (honoApp) currentHonoApp = honoApp; // update the shared ref even when reusing
  rearmAutoStop();
  if (server) return { ok: true, port: OAUTH_LOOPBACK_PORT };

  const { serve } = await import('@hono/node-server');
  return await new Promise<LoopbackResult>((resolve) => {
    let settled = false;
    const s = serve(
      {
        fetch: (req: Request) => {
          const url = new URL(req.url);
          // Browser-login handoff (P7-B): one-shot capture of ?handoff=, then a
          // friendly page. No honoApp needed for this path.
          if (url.pathname === '/cb') {
            const handoff = url.searchParams.get('handoff');
            if (handoff && authCapture) {
              const cb = authCapture;
              authCapture = null; // one-shot
              cb(handoff);
            }
            return new Response(RETURN_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
          }
          if (CALLBACK_PATH.test(url.pathname) && currentHonoApp) return currentHonoApp.fetch(req);
          return new Response('Not found', { status: 404 });
        },
        port: OAUTH_LOOPBACK_PORT,
        hostname: '127.0.0.1',
      },
      () => {
        if (settled) return;
        settled = true;
        server = s;
        resolve({ ok: true, port: OAUTH_LOOPBACK_PORT });
      },
    );
    // EADDRINUSE (or any bind failure) surfaces here before "listening".
    s.on('error', (err: Error) => {
      if (settled) {
        // Post-start error: log, don't crash the main process.
        console.error('[electron] oauth loopback error:', err.message);
        return;
      }
      settled = true;
      server = null;
      clearAutoStop();
      resolve({ ok: false, error: err.message });
    });
  });
}

export function stopOAuthLoopback(): void {
  clearAutoStop();
  authCapture = null;
  currentHonoApp = null;
  if (!server) return;
  server.close();
  server = null;
}

function rearmAutoStop(): void {
  clearAutoStop();
  autoStop = setTimeout(stopOAuthLoopback, AUTO_STOP_MS);
  // Don't keep the app alive just for this timer.
  autoStop.unref?.();
}

function clearAutoStop(): void {
  if (autoStop) {
    clearTimeout(autoStop);
    autoStop = null;
  }
}
