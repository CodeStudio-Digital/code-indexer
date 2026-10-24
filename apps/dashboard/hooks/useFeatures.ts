/**
 * useFeatures — single-fetch hook that reads the runtime feature-flag
 * payload exposed by `/api/config/features`.
 *
 * The dashboard runs in the browser and has no access to `process.env`,
 * so server-side toggles have to be
 * surfaced over HTTP. The fetch happens once on mount and the result
 * is cached in module-level state so any further consumers reuse it.
 *
 * Returns a safe default (all flags on) while the request is in flight
 * so the UI shows the union of capabilities until the server answers —
 * a brief flash of an enabled item is better than a flash of a hidden
 * one when the flag eventually evaluates to true.
 */
import { useEffect, useState } from 'react';

interface FeatureFlags {
  appStudioEnabled: boolean;
}

const DEFAULTS: FeatureFlags = {
  appStudioEnabled: true,
};

let cached: FeatureFlags | null = null;
let inflight: Promise<FeatureFlags> | null = null;

async function fetchFlags(): Promise<FeatureFlags> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = fetch('/api/config/features')
    .then((r) => (r.ok ? (r.json() as Promise<Partial<FeatureFlags>>) : DEFAULTS))
    .catch(() => DEFAULTS)
    .then((flags) => {
      // Merge over DEFAULTS so a flag the server doesn't know about yet
      // (older backend) keeps its safe "on" default instead of vanishing.
      cached = { ...DEFAULTS, ...flags };
      return cached;
    });
  return inflight;
}

export function useFeatures(): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>(cached ?? DEFAULTS);
  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    fetchFlags().then((next) => {
      if (!cancelled) setFlags(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return flags;
}
