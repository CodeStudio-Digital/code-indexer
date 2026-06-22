/**
 * React hook for the cloud auth state. Reads the current state from main on
 * mount and subscribes to `cloud:auth-changed` (so a forced logout — token reuse —
 * flips every gated surface instantly). Gating helpers return false cleanly when
 * logged out; the IDE stays fully usable offline / without an account.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CloudAccount, CloudAuthState } from '@mcp/api-bus';
import { cloudBridge } from './cloud-client.js';

export type CloudSessionState = 'unknown' | 'logged_in' | 'logged_out';

export interface CloudSession {
  state: CloudSessionState;
  account: CloudAccount | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export function useCloudSession(): CloudSession {
  const [state, setState] = useState<CloudSessionState>('unknown');
  const [account, setAccount] = useState<CloudAccount | null>(null);

  const apply = useCallback((s: CloudAuthState) => {
    setState(s.state);
    setAccount(s.account);
  }, []);

  useEffect(() => {
    let alive = true;
    let off: (() => void) | void;
    try {
      cloudBridge()
        .getAuthState()
        .then((s) => alive && apply(s))
        .catch(() => alive && setState('logged_out'));
      off = cloudBridge().onAuthChanged((s) => alive && apply(s));
    } catch {
      setState('logged_out'); // no bridge (browser dev) → treat as logged out
    }
    return () => {
      alive = false;
      off?.();
    };
  }, [apply]);

  const refresh = useCallback(async () => {
    apply(await cloudBridge().getAuthState());
  }, [apply]);

  const signOut = useCallback(async () => {
    await cloudBridge().logout();
  }, []);

  return { state, account, refresh, signOut };
}
