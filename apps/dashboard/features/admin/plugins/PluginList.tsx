/**
 * Left pane of the Plugins master-detail. Shows either the installed plugins
 * (with a local filter + an "install from path/repo" affordance) or the market
 * search results, as a selectable list of icon rows. Selection is by
 * namespace/name (they coincide), lifted to the orchestrator.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Download, Search as SearchIcon } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { norm } from '../../../lib/normalize.js';
import { PluginIcon } from './PluginIcon.js';
import { updateAvailable } from './plugin-version.js';
import type { PluginTab } from './use-plugins.js';
import type { InstalledPluginInfo, MarketPluginInfo } from '@mcp/api-bus';

// Env var name surfaced in the "market unavailable" hint. A const (not raw
// JSX text) so it renders via `{MARKET_ENV}` without tripping the i18n scan.
const MARKET_ENV = 'MCP_MARKET_URL';

interface PluginListProps {
  tab: PluginTab;
  installed: InstalledPluginInfo[];
  results: MarketPluginInfo[];
  marketInfo: Record<string, MarketPluginInfo | null>;
  searched: boolean;
  busy: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSearch: (query: string) => void;
  onInstallFrom: (raw: string) => void;
}

export function PluginList({
  tab,
  installed,
  results,
  marketInfo,
  searched,
  busy,
  selectedId,
  onSelect,
  onSearch,
  onInstallFrom,
}: PluginListProps) {
  const { t } = useTranslation('plugins');
  const [filter, setFilter] = useState('');
  const [marketQuery, setMarketQuery] = useState('');
  const [source, setSource] = useState('');

  const inputCls =
    'w-full h-8 rounded-md border border-input bg-background pl-8 pr-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

  const rowCls = (active: boolean): string =>
    cn(
      'w-full text-left flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors',
      active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
    );

  const nq = norm(filter.trim());
  const visibleInstalled = installed.filter(
    (p) => !nq || norm(p.name).includes(nq) || norm(p.namespace).includes(nq),
  );

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b shrink-0 space-y-2">
        {/* Top input: market search (Market tab) or local filter (Installed). */}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
          {tab === 'market' ? (
            <input
              value={marketQuery}
              onChange={(e) => setMarketQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSearch(marketQuery)}
              placeholder={t('panel.marketSearchPlaceholder')}
              className={inputCls}
            />
          ) : (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('panel.searchPlaceholder')}
              className={inputCls}
            />
          )}
        </div>

        {/* Installed: install from a folder path or owner/repo. */}
        {tab === 'installed' && (
          <div className="flex gap-1.5">
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onInstallFrom(source);
                  setSource('');
                }
              }}
              placeholder={t('panel.installSourcePlaceholder')}
              className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <button
              type="button"
              disabled={busy || !source.trim()}
              onClick={() => {
                onInstallFrom(source);
                setSource('');
              }}
              className="rounded-md bg-primary px-2.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {t('panel.install')}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5">
        {tab === 'installed' ? (
          installed.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">{t('panel.noInstalled')}</div>
          ) : (
            visibleInstalled.map((p) => {
              const hasUpdate = updateAvailable(p.version, marketInfo[p.namespace]?.latestVersion);
              return (
                <button
                  key={p.namespace}
                  type="button"
                  onClick={() => onSelect(p.namespace)}
                  className={rowCls(selectedId === p.namespace)}
                >
                  <PluginIcon name={p.namespace} displayName={p.name} size={30} className={cn(!p.enabled && 'opacity-50 grayscale')} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium leading-tight">{p.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{p.namespace}</div>
                  </div>
                  {hasUpdate && (
                    <span
                      title={t('panel.update')}
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                    />
                  )}
                  {!p.enabled && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{t('panel.disabledTag')}</span>
                  )}
                </button>
              );
            })
          )
        ) : results.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            {searched ? (
              <>
                {t('panel.noResults')} <code>{MARKET_ENV}</code>.
              </>
            ) : (
              t('panel.marketPrompt')
            )}
          </div>
        ) : (
          results.map((r) => {
            const isInstalled = installed.some((p) => p.namespace === r.name);
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => onSelect(r.name)}
                className={rowCls(selectedId === r.name)}
              >
                <PluginIcon name={r.name} displayName={r.displayName} brandColor={r.brandColor} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium leading-tight">{r.displayName ?? r.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    ↓{r.downloads}
                    {r.category ? ` · ${r.category}` : ''}
                  </div>
                </div>
                {isInstalled && <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                {!isInstalled && <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
