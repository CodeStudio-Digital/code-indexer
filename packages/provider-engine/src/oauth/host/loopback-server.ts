/**
 * Generic loopback redirect server — the host primitive behind
 * `OAuthHostCapabilities.loopback`, for authorization-code flows (chatgpt /
 * google-oauth / claude-code). Generalizes services/oauth/openai.ts's one-shot
 * `createServer` on 127.0.0.1: bind on a declared port (or ephemeral 0), capture
 * `?code=&state=` at the callback path, validate state, respond with a
 * close-this-tab page, and resolve `waitForCode()`.
 *
 * Leaf: imports only the `@mcp/provider-sdk` auth type + node:http/net. NOT
 * barrel-exported (kept off the registry's module graph). The token EXCHANGE +
 * the provider-specific hooks (chatgpt account-id, google projectId) are NOT
 * here — only the redirect capture.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoopbackBinding } from '@mcp/provider-sdk';

export interface LoopbackOptions {
  /** Fixed port (e.g. 1455/1456 for a provider's registered redirect). 0/undefined → ephemeral. */
  port?: number;
  /** Callback path (default '/auth/callback'). */
  path?: string;
  /** Reject `waitForCode()` after this many ms (default 5 min). */
  timeoutMs?: number;
  /** When set, a callback whose `state` differs is 400'd and ignored (CSRF guard). */
  expectedState?: string;
}

const OK_HTML =
  '<html><body style="font-family:sans-serif;padding:2rem">' +
  '<h3>✅ Connected</h3><p>You can close this tab and return to the app.</p>' +
  '<script>setTimeout(()=>window.close(),500)</script></body></html>';

export async function startLoopbackServer(opts?: LoopbackOptions): Promise<LoopbackBinding> {
  const path = opts?.path ?? '/auth/callback';
  const timeoutMs = opts?.timeoutMs ?? 5 * 60 * 1000;

  let settle: ((v: { code: string; state: string }) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const close = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };

  const server = createServer((req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://localhost');
      if (u.pathname !== path) {
        res.writeHead(404).end('not found');
        return;
      }
      const state = u.searchParams.get('state') ?? '';
      const code = u.searchParams.get('code') ?? '';
      const error = u.searchParams.get('error') ?? '';
      if (opts?.expectedState !== undefined && state !== opts.expectedState) {
        res
          .writeHead(400, { 'Content-Type': 'text/html' })
          .end('<html><body><h3>Invalid state</h3><p>You can close this tab.</p></body></html>');
        return;
      }
      res
        .writeHead(error ? 400 : 200, { 'Content-Type': 'text/html' })
        .end(error ? `<html><body><h3>Connection failed</h3><p>${error}</p></body></html>` : OK_HTML);
      if (!settled) {
        settled = true;
        if (error) fail?.(new Error(error));
        else if (code) settle?.({ code, state });
        else fail?.(new Error('no_code_or_error'));
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        // One-shot: close shortly after responding so the port frees up.
        setTimeout(() => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        }, 200).unref?.();
      }
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts?.port ?? 0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error('failed to bind loopback server'));
        return;
      }
      resolve(addr.port);
    });
  });

  timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      close();
      fail?.(new Error('loopback timeout'));
    }
  }, timeoutMs);
  timer.unref?.();

  return {
    // 'localhost' (not 127.0.0.1) to match providers' registered redirect URIs.
    redirectUri: `http://localhost:${boundPort}${path}`,
    waitForCode: () => codePromise,
    close,
  };
}
