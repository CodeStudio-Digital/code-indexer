import { useCallback, useEffect, useRef } from 'react';
import { fetchOAuthStatus, startOAuthAuthorize } from './mcp-servers-api.js';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface OAuthFlowTexts {
  /** Shown when the ephemeral loopback can't bind (port busy). */
  loopbackError: string;
  /** Shown when the web popup is blocked. */
  popupBlocked: string;
  /** Shown when consent doesn't complete within the poll window. */
  timeout: string;
}

interface Options {
  onConnected: () => void;
  onError: (message: string) => void;
  texts: OAuthFlowTexts;
}

interface McpOAuthFlow {
  /** Begin authorization: opens the provider login and watches for completion. */
  authorize: (serverId: string) => Promise<void>;
  /** Stop watching + tear down the loopback (call on disconnect / dialog close). */
  cancel: () => void;
}

/**
 * Drives the "Authorize" step of MCP OAuth from the dashboard.
 *
 * Desktop (Electron): start an ephemeral 127.0.0.1 loopback, open the
 * provider login in the user's real browser via `openExternal`, then poll
 * `oauth/status` until `connected` — the callback lands in an external
 * browser and can't postMessage back into the desktop window.
 *
 * Web: open a popup synchronously (inside the click gesture, so the popup
 * blocker leaves it alone) and let the callback page postMessage the result.
 */
export function useMcpOAuthFlow({ onConnected, onError, texts }: Options): McpOAuthFlow {
  // Keep the latest callbacks/strings in a ref so the effects below don't
  // re-subscribe on every render (callers pass inline closures).
  const cbs = useRef({ onConnected, onError, texts });
  cbs.current = { onConnected, onError, texts };

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const serverIdRef = useRef<string | null>(null);
  // Wall-clock (ms) when the current attempt started. A token is only "ours"
  // if it was written after this — guards against a stale token from a prior
  // flow instantly flipping the dialog to "connected".
  const baselineRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    stopPolling();
    serverIdRef.current = null;
    window.electronAPI?.oauthLoopbackStop?.();
  }, [stopPolling]);

  // Web popup path: the callback page posts the outcome back to its opener.
  useEffect(() => {
    const listener = (ev: MessageEvent): void => {
      const data = ev.data as {
        ok?: boolean; server_id?: string; error?: string; error_description?: string;
      };
      if (!data || typeof data !== 'object') return;
      const sid = serverIdRef.current;
      if (!sid || (data.server_id && data.server_id !== sid)) return;
      if (data.ok) { cancel(); cbs.current.onConnected(); }
      else if (data.error) { cancel(); cbs.current.onError(data.error_description ?? data.error); }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [cancel]);

  // Tear everything down if the dialog unmounts mid-flow.
  useEffect(() => cancel, [cancel]);

  const startPolling = useCallback((serverId: string) => {
    stopPolling();
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    pollTimer.current = setInterval(() => {
      if (Date.now() > deadline) { cancel(); cbs.current.onError(cbs.current.texts.timeout); return; }
      void fetchOAuthStatus(serverId)
        .then((s) => {
          // Only a token written AFTER this attempt started counts — a stale
          // token from an earlier flow must not report success.
          if (s.token_updated_at !== null && s.token_updated_at > baselineRef.current) {
            cancel();
            cbs.current.onConnected();
          }
        })
        .catch(() => { /* transient fetch error — keep polling */ });
    }, POLL_INTERVAL_MS);
  }, [cancel, stopPolling]);

  const authorize = useCallback(async (serverId: string): Promise<void> => {
    serverIdRef.current = serverId;
    const electron = window.electronAPI;
    const loopbackStart = electron?.oauthLoopbackStart;
    const openExternal = electron?.openExternal;
    const { texts: tx } = cbs.current;

    if (loopbackStart && openExternal) {
      // Desktop: capture the redirect with an ephemeral loopback, open the
      // login in the user's real (already-signed-in) browser, then poll.
      const res = await loopbackStart();
      if (!res?.ok) {
        cbs.current.onError(res?.error ? `${tx.loopbackError} (${res.error})` : tx.loopbackError);
        return;
      }
      let url: string;
      try {
        url = (await startOAuthAuthorize(serverId)).authorization_url;
      } catch (e) {
        cancel();
        cbs.current.onError(e instanceof Error ? e.message : String(e));
        return;
      }
      baselineRef.current = Date.now();
      openExternal(url);
      startPolling(serverId);
      return;
    }

    // Web: open the popup in the click gesture (before any await), then
    // navigate it once the URL arrives — avoids the post-await popup block.
    const popup = window.open('about:blank', 'mcp-oauth', 'width=520,height=700');
    if (!popup) { cbs.current.onError(tx.popupBlocked); return; }
    try {
      const { authorization_url } = await startOAuthAuthorize(serverId);
      popup.location.href = authorization_url;
    } catch (e) {
      popup.close();
      cbs.current.onError(e instanceof Error ? e.message : String(e));
    }
  }, [cancel, startPolling]);

  return { authorize, cancel };
}
