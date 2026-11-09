import { useCallback, useEffect, useRef } from 'react';
import { cancelOAuthAuthorize, fetchOAuthStatus, startOAuthAuthorize } from './mcp-servers-api.js';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
interface OAuthFlowTexts { loopbackError: string; popupBlocked: string; timeout: string; }
interface Options { onConnected: () => void; onError: (message: string) => void; texts: OAuthFlowTexts; }
interface Attempt { serverId: string; state?: string; popup?: Window; desktop: boolean; deadline: number; timer?: ReturnType<typeof setTimeout>; }

/** Poll the exact authorization attempt on desktop and web. Popup messages are
 * only wake-up hints; token completion is always verified with our backend. */
export function useMcpOAuthFlow({ onConnected, onError, texts }: Options) {
  const cbs = useRef({ onConnected, onError, texts });
  cbs.current = { onConnected, onError, texts };
  const active = useRef<Attempt | null>(null);
  const cancel = useCallback(() => {
    const attempt = active.current;
    active.current = null;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempt.popup?.close();
    if (attempt.desktop) window.electronAPI?.oauthLoopbackStop?.();
    if (attempt.state) void cancelOAuthAuthorize(attempt.serverId, attempt.state).catch(() => undefined);
  }, []);
  useEffect(() => cancel, [cancel]);

  const authorize = useCallback(async (serverId: string) => {
    cancel();
    const electron = window.electronAPI;
    const desktop = !!(electron?.oauthLoopbackStart && electron?.openExternal);
    const attempt: Attempt = { serverId, desktop, deadline: Date.now() + POLL_TIMEOUT_MS };
    active.current = attempt;
    const current = () => active.current === attempt;
    const fail = (message: string) => { if (current()) { cancel(); cbs.current.onError(message); } };
    if (!desktop) {
      attempt.popup = window.open('about:blank', 'mcp-oauth', 'width=520,height=700') ?? undefined;
      if (!attempt.popup) { fail(cbs.current.texts.popupBlocked); return; }
    }
    try {
      if (desktop) {
        const result = await electron!.oauthLoopbackStart!();
        if (!current()) { if (!active.current?.desktop) electron!.oauthLoopbackStop?.(); return; }
        if (!result.ok) throw new Error(`${cbs.current.texts.loopbackError}${result.error ? ` (${result.error})` : ''}`);
      }
      const flow = await startOAuthAuthorize(serverId);
      if (!current()) { void cancelOAuthAuthorize(serverId, flow.state).catch(() => undefined); return; }
      attempt.state = flow.state;
      if (desktop) await (electron!.oauthOpenExternal ?? electron!.openExternal)(flow.authorization_url);
      else attempt.popup!.location.href = flow.authorization_url;
      if (!current()) return;
      const poll = async () => {
        if (!current()) return;
        if (Date.now() >= attempt.deadline) { fail(cbs.current.texts.timeout); return; }
        try {
          const status = await fetchOAuthStatus(serverId, attempt.state);
          if (!current()) return;
          if (status.attempt && status.attempt.state === attempt.state && status.attempt.status === 'authenticated') {
            cancel(); cbs.current.onConnected(); return;
          }
          if (status.attempt?.status === 'error') { fail(status.attempt.error ?? 'Authorization failed'); return; }
          if (status.attempt?.status === 'expired') { fail(cbs.current.texts.timeout); return; }
        } catch { /* Retry a transient local status error until the deadline. */ }
        if (current()) attempt.timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      };
      void poll();
    } catch (e) { fail(e instanceof Error ? e.message : String(e)); }
  }, [cancel]);
  return { authorize, cancel };
}
