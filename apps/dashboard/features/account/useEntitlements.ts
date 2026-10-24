/**
 * Read-only entitlements for per-feature UI gating (locks / upgrade CTAs). The
 * local IDE is never gated; this only decides whether a CLOUD feature shows an
 * "upgrade" affordance. Real enforcement stays server-side — this is UX only.
 *
 * Source: the localStorage cache that `useAccountGate` maintains at the app root,
 * plus a one-shot refresh on mount (so a freshly-opened dialog reflects the live
 * tier even in the same tab, where `storage` events don't fire).
 */
import { useEffect, useState } from 'react';
import type { Entitlements } from '@mcp/api-bus';
import { cloudCall } from '../../lib/cloud/cloud-client.js';

const ENT_CACHE_KEY = 'mcp-cloud:entitlements';

function readCache(): Entitlements | null {
  try {
    const raw = localStorage.getItem(ENT_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Entitlements) : null;
  } catch {
    return null;
  }
}

type CloudFeature = keyof Entitlements['features'];

export function useEntitlements(): {
  entitlements: Entitlements | null;
  /** True iff the cloud feature is unlocked at the current tier. */
  has: (feature: CloudFeature) => boolean;
} {
  const [ent, setEnt] = useState<Entitlements | null>(() => readCache());

  useEffect(() => {
    let alive = true;
    // Refresh once (no-op offline / no bridge → keep the cached verdict).
    cloudCall('account.entitlements', undefined)
      .then((e) => {
        if (!alive) return;
        setEnt(e);
        try {
          localStorage.setItem(ENT_CACHE_KEY, JSON.stringify(e));
        } catch {
          /* storage full/disabled — non-fatal */
        }
      })
      .catch(() => {
        /* offline / not signed in → keep cache */
      });
    const onStorage = (evt: StorageEvent): void => {
      if (evt.key === ENT_CACHE_KEY) setEnt(readCache());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      alive = false;
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { entitlements: ent, has: (feature) => !!ent?.features?.[feature] };
}
