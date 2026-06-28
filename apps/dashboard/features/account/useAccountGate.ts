/**
 * Decides whether the app is usable: you must be signed in AND entitled (an
 * active trial or subscription → entitlements.tier !== 'free'). The trial is
 * granted server-side per ACCOUNT (not per machine) on the first entitlements
 * call, so reinstalling / another PC can't re-trial.
 *
 * Resilience: entitlements are cached (localStorage) so an offline launch keeps
 * the last-known verdict; a transient fetch failure NEVER locks a signed-in user
 * out (fail-open). The whole gate is also bypassable via `window.mcp.bypassCloudGate()`
 * and is inert when the Electron cloud bridge is absent (browser dev).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Entitlements } from '@mcp/api-bus';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { useCloudSession, type CloudSession } from '../../lib/cloud/use-cloud-session.js';
import { consumeCheckoutPending } from '../../lib/cloud/checkout-pending.js';
import { toast } from '../../components/ui/prompt-dialog.js';

export type GateDecision = 'loading' | 'login' | 'allow';

const ENT_CACHE_KEY = 'mcp-cloud:entitlements';
const BYPASS_KEY = 'mcp-cloud:gate-bypass';

function readCache(): Entitlements | null {
  try {
    const raw = localStorage.getItem(ENT_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Entitlements) : null;
  } catch {
    return null;
  }
}

const isDev = (): boolean => !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;

/**
 * Gate enforces only in the desktop app (cloud bridge present). The localStorage
 * bypass is honored ONLY in dev — in a production build it is ignored, so editing
 * localStorage / calling the dev helper can't disable the paywall. (The local IDE
 * is still inherently bypassable by patching the bundle; the REAL enforcement is
 * server-side — every paid cloud route re-checks entitlement.)
 */
function gateActive(): boolean {
  if (typeof window === 'undefined') return false;
  const hasBridge = !!(window as unknown as { electronAPI?: { cloud?: unknown } }).electronAPI?.cloud;
  if (!hasBridge) return false;
  if (isDev()) {
    try {
      if (localStorage.getItem(BYPASS_KEY) === '1') return false;
    } catch {
      /* ignore */
    }
  }
  return true;
}

export interface AccountGateState {
  decision: GateDecision;
  entitlements: Entitlements | null;
  account: CloudSession['account'];
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export function useAccountGate(): AccountGateState {
  const session = useCloudSession();
  const { t } = useTranslation('cloud');
  const [ent, setEnt] = useState<Entitlements | null>(() => readCache());
  const [loading, setLoading] = useState(false);
  const lastFocusRefreshRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const e = await cloudCall('account.entitlements', undefined);
      setEnt(e);
      try {
        localStorage.setItem(ENT_CACHE_KEY, JSON.stringify(e));
      } catch {
        /* storage full / disabled — non-fatal */
      }
    } catch {
      /* offline or server error → keep the cached verdict; never lock out on a blip */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session.state === 'logged_in') {
      void refresh();
    } else if (session.state === 'logged_out') {
      setEnt(null);
      try {
        localStorage.removeItem(ENT_CACHE_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [session.state, refresh]);

  // Post-purchase activation: Stripe checkout opens in the system browser and
  // redirects to the web portal, so the desktop never observes the result. When
  // the window regains focus we (a) refresh entitlements (throttled) so a tier
  // change reflects, and (b) if a checkout was just opened, reconcile via
  // billing.sync to self-heal a missed webhook and toast the activation. The toast
  // is gated on `pending` so the auto-granted trial never triggers it.
  useEffect(() => {
    if (session.state !== 'logged_in') return;
    const onFocus = (): void => {
      void (async () => {
        const pending = consumeCheckoutPending();
        const now = Date.now();
        if (!pending && now - lastFocusRefreshRef.current < 60_000) return; // throttle plain refreshes
        lastFocusRefreshRef.current = now;
        const before = readCache()?.tier ?? 'free';
        if (pending) {
          try {
            await cloudCall('billing.sync', undefined);
          } catch {
            /* best-effort self-heal; the webhook is still the primary activation path */
          }
        }
        await refresh();
        if (pending && before === 'free' && (readCache()?.tier ?? 'free') !== 'free') {
          toast.success(t('activation.title'), { description: t('activation.body') });
        }
      })();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [session.state, refresh, t]);

  let decision: GateDecision;
  if (!gateActive()) decision = 'allow';
  else if (session.state === 'unknown') decision = 'loading';
  else if (session.state === 'logged_out') decision = 'login';
  // Signed in at ANY tier (incl. free / expired trial) → the local IDE is free.
  // There is NO subscription paywall: cloud FEATURES gate per-use (see useEntitlements),
  // enforced server-side. Only sign-in is required (so we know who's using the app).
  else decision = 'allow';

  return { decision, entitlements: ent, account: session.account, refresh, signOut: session.signOut };
}
