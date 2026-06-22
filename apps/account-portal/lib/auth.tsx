/** Auth context — loads the signed-in account + entitlements once, exposes reload
 *  and signOut. Token lifecycle lives in api.ts; this is the React-facing state. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Entitlements } from '@mcp/api-bus';
import { api, tokens, ApiError, type Account } from './api.js';

interface AuthState {
  account: Account | null;
  entitlements: Entitlements | null;
  loading: boolean;
  reload: () => Promise<void>;
  signOut: (all?: boolean) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!tokens.isLoggedIn) {
      setAccount(null);
      setEntitlements(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const me = await api.me();
      setAccount(me.account);
      try {
        setEntitlements(await api.entitlements());
      } catch {
        setEntitlements(null); // entitlements are non-critical for rendering
      }
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'auth_required' || e.kind === 'forced_logout')) {
        tokens.clear();
        setAccount(null);
        setEntitlements(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const signOut = useCallback(async (all?: boolean) => {
    try {
      await (all ? api.logoutAll() : api.logout());
    } catch {
      /* best-effort; clear locally regardless */
    }
    tokens.clear();
    setAccount(null);
    setEntitlements(null);
  }, []);

  return <Ctx.Provider value={{ account, entitlements, loading, reload, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
