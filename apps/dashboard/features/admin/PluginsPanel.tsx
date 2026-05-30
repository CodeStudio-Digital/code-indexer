/**
 * Plugins settings panel (global, app-level — lives in Admin, not the
 * per-project workspace). Two tabs: Installed (enable/disable/uninstall +
 * install from path or owner/repo) and Market (search + install). Drives the
 * `plugins.*` api-bus methods; re-hydrates the contribution registry after any
 * change so rail icons / palette themes update live.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2, Download, Search as SearchIcon } from 'lucide-react';
import { apiCall } from '../../lib/api-client.js';
import { hydrateContributions } from '../../state/contribution-registry.js';
import type { InstalledPluginInfo, MarketPluginInfo, PluginPermissionsShape } from '@mcp/api-bus';

type Tab = 'installed' | 'market';
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Human-readable summary of a plugin's granted capabilities (install == consent). */
function summarizePermissions(p: PluginPermissionsShape | null): string[] {
  if (!p) return [];
  const out: string[] = [];
  const reads = p.fs?.read?.length ?? 0;
  const writes = p.fs?.write?.length ?? 0;
  if (reads || writes) out.push(`fs: ${reads} read${writes ? `, ${writes} write` : ''}`);
  if (p.exec?.allow?.length) out.push(`exec: ${p.exec.allow.join(', ')}`);
  if (p.storage) out.push('storage');
  return out;
}

export function PluginsPanel() {
  const [tab, setTab] = useState<Tab>('installed');
  const [installed, setInstalled] = useState<InstalledPluginInfo[]>([]);
  const [results, setResults] = useState<MarketPluginInfo[]>([]);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const installFrom = (): void => {
    const v = source.trim();
    if (!v) return;
    const isRepo = /^[\w.-]+\/[\w.-]+$/.test(v);
    void run(() =>
      apiCall('plugins.install', {
        source: isRepo ? { source: 'github', repo: v } : { source: 'local', path: v },
      }),
    ).then(() => setSource(''));
  };

  const search = (): void => {
    setBusy(true);
    setError(null);
    apiCall<MarketPluginInfo[]>('plugins.searchMarket', { query })
      .then(setResults)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  };

  const input = 'flex-1 bg-background border border-border rounded px-2 py-1.5 text-xs';
  const row = 'flex items-center gap-3 rounded-md border px-3 py-2';

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-2">
        {(['installed', 'market'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
              tab === t ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
        <button onClick={() => void run(async () => undefined)} title="Refresh" className="ml-auto text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error && <div className="rounded-md border border-status-error/40 px-3 py-2 text-xs text-status-error">{error}</div>}

      {tab === 'installed' ? (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && installFrom()}
              placeholder="Install from a folder path or owner/repo"
              className={input}
            />
            <button onClick={installFrom} disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-50">
              Install
            </button>
          </div>
          {installed.length === 0 ? (
            <div className="rounded-md border p-6 text-center text-xs text-muted-foreground">No plugins installed.</div>
          ) : (
            <div className="grid gap-2">
              {installed.map((p) => (
                <div key={p.namespace} className={row}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {p.name} <span className="text-muted-foreground">v{p.version}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{p.namespace} · {p.source}</div>
                    {summarizePermissions(p.permissions).length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {summarizePermissions(p.permissions).map((cap) => (
                          <span
                            key={cap}
                            title="Granted at install — uninstall to revoke"
                            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      disabled={busy}
                      onChange={() => void run(() => apiCall('plugins.setEnabled', { namespace: p.namespace, enabled: !p.enabled }))}
                    />
                    enabled
                  </label>
                  <button
                    title="Uninstall"
                    disabled={busy}
                    onClick={() => void run(() => apiCall('plugins.uninstall', { namespace: p.namespace }))}
                    className="text-muted-foreground hover:text-status-error disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              placeholder="Search the market…"
              className={input}
            />
            <button onClick={search} disabled={busy} className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50">
              <SearchIcon className="h-4 w-4" />
            </button>
          </div>
          {results.length === 0 ? (
            <div className="rounded-md border p-6 text-center text-xs text-muted-foreground">
              No results. The hosted Market requires <code>MCP_MARKET_URL</code>.
            </div>
          ) : (
            <div className="grid gap-2">
              {results.map((r) => (
                <div key={r.name} className={row}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {r.displayName ?? r.name} <span className="text-muted-foreground">v{r.latestVersion}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{r.description ?? r.name} · ↓{r.downloads}</div>
                  </div>
                  <button
                    title="Install"
                    disabled={busy}
                    onClick={() => void run(() => apiCall('plugins.install', { source: { source: 'market', name: r.name } }))}
                    className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" /> Install
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
