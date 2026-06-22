/**
 * Data + actions for the Plugins master-detail panel. Owns the installed
 * list, market search results, a lazy per-plugin `marketInfo` cache (for
 * "update available" detection without an N+1 fan-out on mount), the current
 * selection, and all mutations. Every mutation reloads the list and
 * re-hydrates the contribution registry so rail icons / palette themes update
 * live (same contract as the old panel).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiCall } from '../../../lib/api-client.js';
import { hydrateContributions } from '../../../state/contribution-registry.js';
import type { InstalledPluginInfo, MarketPluginInfo } from '@mcp/api-bus';

export type PluginTab = 'installed' | 'market';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function usePlugins() {
  const [installed, setInstalled] = useState<InstalledPluginInfo[]>([]);
  const [results, setResults] = useState<MarketPluginInfo[]>([]);
  const [marketInfo, setMarketInfo] = useState<Record<string, MarketPluginInfo | null>>({});
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Names already requested from `marketInfo` — guards against duplicate
  // in-flight fetches when a selection re-renders before the state lands.
  const requestedInfo = useRef<Set<string>>(new Set());

  const loadInstalled = useCallback(async () => {
    try {
      setInstalled(await apiCall<InstalledPluginInfo[]>('plugins.list', undefined));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  /** Run a mutation, then reload the list + re-hydrate contributions. */
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await loadInstalled();
        await hydrateContributions();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [loadInstalled],
  );

  const search = useCallback((query: string) => {
    setBusy(true);
    setError(null);
    apiCall<MarketPluginInfo[]>('plugins.searchMarket', { query })
      .then((r) => {
        setResults(r);
        setSearched(true);
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  }, []);

  /** Fetch market metadata for one plugin once, cached. No-op if already requested. */
  const ensureMarketInfo = useCallback((name: string) => {
    if (requestedInfo.current.has(name)) return;
    requestedInfo.current.add(name);
    apiCall<MarketPluginInfo | null>('plugins.marketInfo', { name })
      .then((info) => setMarketInfo((prev) => ({ ...prev, [name]: info })))
      .catch(() => {
        // Market may be unconfigured / plugin absent — treat as "no info".
        setMarketInfo((prev) => ({ ...prev, [name]: null }));
      });
  }, []);

  // ── Mutations ────────────────────────────────────────────────────────────
  const installFrom = useCallback(
    (raw: string) => {
      const v = raw.trim();
      if (!v) return Promise.resolve();
      const isRepo = /^[\w.-]+\/[\w.-]+$/.test(v);
      return run(() =>
        apiCall('plugins.install', {
          source: isRepo ? { source: 'github', repo: v } : { source: 'local', path: v },
        }),
      );
    },
    [run],
  );

  const installMarket = useCallback(
    (name: string) => run(() => apiCall('plugins.install', { source: { source: 'market', name } })),
    [run],
  );

  const update = useCallback(
    (name: string) =>
      run(() => apiCall('plugins.install', { source: { source: 'market', name }, overwrite: true })),
    [run],
  );

  const setEnabled = useCallback(
    (namespace: string, enabled: boolean) =>
      run(() => apiCall('plugins.setEnabled', { namespace, enabled })),
    [run],
  );

  const uninstall = useCallback(
    (namespace: string) => run(() => apiCall('plugins.uninstall', { namespace })),
    [run],
  );

  const refresh = useCallback(() => run(async () => undefined), [run]);

  return {
    installed,
    results,
    marketInfo,
    searched,
    error,
    busy,
    ensureMarketInfo,
    search,
    installFrom,
    installMarket,
    update,
    setEnabled,
    uninstall,
    refresh,
  };
}
