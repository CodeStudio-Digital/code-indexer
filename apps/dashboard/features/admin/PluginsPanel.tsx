/**
 * Plugins settings panel (global, app-level — lives in Admin, not the
 * per-project workspace). IntelliJ-style master-detail: a searchable list of
 * Installed / Market plugins on the left, a detail pane on the right (metadata,
 * permissions, README, and Enable/Disable · Update · Install/Uninstall
 * actions). Drives the `plugins.*` api-bus methods via `usePlugins`, which
 * re-hydrates the contribution registry after any change so rail icons /
 * palette themes update live.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '../../lib/utils.js';
import { PluginList } from './plugins/PluginList.js';
import { PluginDetail } from './plugins/PluginDetail.js';
import { usePlugins, type PluginTab } from './plugins/use-plugins.js';

export function PluginsPanel() {
  const { t } = useTranslation('plugins');
  const [tab, setTab] = useState<PluginTab>('installed');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const p = usePlugins();

  const selectTab = (next: PluginTab): void => {
    setTab(next);
    setSelectedId(null);
  };

  return (
    <div className="flex flex-col h-full min-h-[520px] text-sm">
      <div className="flex items-center gap-2 pb-2 shrink-0">
        {(['installed', 'market'] as const).map((tabId) => (
          <button
            key={tabId}
            type="button"
            onClick={() => selectTab(tabId)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium',
              tab === tabId
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tabId === 'installed' ? t('panel.tabs.installed') : t('panel.tabs.market')}
          </button>
        ))}
        <button
          type="button"
          onClick={p.refresh}
          title={t('panel.refresh')}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {p.error && (
        <div className="mb-2 rounded-md border border-status-error/40 px-3 py-2 text-xs text-status-error shrink-0">
          {p.error}
        </div>
      )}

      <div className="flex-1 min-h-0 rounded-md border overflow-hidden">
        <PanelGroup direction="horizontal" autoSaveId="mcp-admin-plugins-horiz">
          <Panel defaultSize={34} minSize={22} maxSize={50}>
            <div className="h-full border-r overflow-hidden">
              <PluginList
                tab={tab}
                installed={p.installed}
                results={p.results}
                marketInfo={p.marketInfo}
                searched={p.searched}
                busy={p.busy}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onSearch={p.search}
                onInstallFrom={p.installFrom}
              />
            </div>
          </Panel>
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <Panel minSize={40}>
            <PluginDetail
              selectedId={selectedId}
              installed={p.installed}
              results={p.results}
              marketInfo={p.marketInfo}
              busy={p.busy}
              onEnsureMarketInfo={p.ensureMarketInfo}
              onSetEnabled={p.setEnabled}
              onUninstall={p.uninstall}
              onInstallMarket={p.installMarket}
              onUpdate={p.update}
            />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
