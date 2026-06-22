/**
 * Right pane of the Plugins master-detail. Renders the selected plugin's
 * metadata (icon, vendor, version, category, downloads), declared permissions,
 * README (installed plugins, lazily read from disk), and the action buttons
 * (Enable/Disable, Update, Install/Uninstall). Resolves the selection across
 * the installed list + market results + the lazy `marketInfo` cache.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Switch } from '../../../components/ui/switch.js';
import { apiCall } from '../../../lib/api-client.js';
import { Markdown } from '../../chat/messages/Markdown.js';
import { PluginIcon } from './PluginIcon.js';
import { summarizePermissions } from './plugin-permissions.js';
import { updateAvailable } from './plugin-version.js';
import type { InstalledPluginInfo, MarketPluginInfo } from '@mcp/api-bus';

interface PluginDetailProps {
  selectedId: string | null;
  installed: InstalledPluginInfo[];
  results: MarketPluginInfo[];
  marketInfo: Record<string, MarketPluginInfo | null>;
  busy: boolean;
  onEnsureMarketInfo: (name: string) => void;
  onSetEnabled: (namespace: string, enabled: boolean) => void;
  onUninstall: (namespace: string) => void;
  onInstallMarket: (name: string) => void;
  onUpdate: (name: string) => void;
}

export function PluginDetail({
  selectedId,
  installed,
  results,
  marketInfo,
  busy,
  onEnsureMarketInfo,
  onSetEnabled,
  onUninstall,
  onInstallMarket,
  onUpdate,
}: PluginDetailProps) {
  const { t } = useTranslation('plugins');
  const [readme, setReadme] = useState<string | null>(null);

  const inst = selectedId ? installed.find((p) => p.namespace === selectedId) : undefined;
  const market: MarketPluginInfo | null =
    (selectedId ? marketInfo[selectedId] : null) ??
    (selectedId ? results.find((r) => r.name === selectedId) ?? null : null);

  const installedNamespace = inst?.namespace;

  // Fetch market metadata once per selection (drives update detection).
  useEffect(() => {
    if (selectedId) onEnsureMarketInfo(selectedId);
  }, [selectedId, onEnsureMarketInfo]);

  // README is read from the plugin's own dir — installed plugins only.
  useEffect(() => {
    setReadme(null);
    if (!installedNamespace) return;
    let cancelled = false;
    apiCall<{ content: string }>('plugins.readAsset', {
      namespace: installedNamespace,
      path: 'README.md',
    })
      .then((r) => {
        if (!cancelled) setReadme(r.content);
      })
      .catch(() => {
        if (!cancelled) setReadme(null); // absent / unreadable — show nothing
      });
    return () => {
      cancelled = true;
    };
  }, [installedNamespace]);

  if (!selectedId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t('panel.detail.selectPrompt')}
      </div>
    );
  }

  const displayName = market?.displayName ?? inst?.name ?? selectedId;
  const version = inst?.version ?? market?.latestVersion ?? '';
  const hasUpdate = !!inst && updateAvailable(inst.version, market?.latestVersion);
  const perms = summarizePermissions(inst?.permissions, t);

  const metaRow = (label: string, value: string) => (
    <div className="flex gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header — icon + identity + primary actions. */}
      <div className="flex items-start gap-3 border-b p-4 shrink-0">
        <PluginIcon name={selectedId} displayName={displayName} brandColor={market?.brandColor} size={48} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{displayName}</div>
          <div className="truncate text-xs text-muted-foreground">
            {selectedId} · {t('panel.detail.version', { version })}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {inst ? (
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={inst.enabled}
                  disabled={busy}
                  onCheckedChange={() => onSetEnabled(inst.namespace, !inst.enabled)}
                />
                {t('panel.enabled')}
              </label>
              {hasUpdate && (
                <Button size="sm" disabled={busy} onClick={() => onUpdate(inst.namespace)}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> {t('panel.update')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onUninstall(inst.namespace)}
                title={t('panel.uninstall')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => onInstallMarket(selectedId)}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> {t('panel.install')}
            </Button>
          )}
        </div>
      </div>

      {/* Body — metadata + permissions + readme. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {hasUpdate && (
          <div className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs text-primary">
            {t('panel.updateAvailable', { version: market?.latestVersion ?? '' })}
          </div>
        )}

        {market?.description && <p className="text-sm text-muted-foreground">{market.description}</p>}

        <div className="space-y-1.5">
          {market?.author && metaRow(t('panel.detail.vendor'), market.author)}
          {market?.category && metaRow(t('panel.detail.category'), market.category)}
          {market && metaRow(t('panel.detail.downloads'), String(market.downloads))}
          {inst && metaRow(t('panel.detail.source'), inst.source)}
        </div>

        {perms.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs font-semibold">{t('panel.detail.permissions')}</div>
            <div className="flex flex-wrap gap-1">
              {perms.map((cap) => (
                <span
                  key={cap}
                  title={t('panel.permissionTitle')}
                  className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {cap}
                </span>
              ))}
            </div>
          </div>
        )}

        {readme && (
          <div className="space-y-1.5">
            <div className="text-xs font-semibold">{t('panel.detail.readme')}</div>
            <div className="rounded-md border bg-card/40 p-3">
              <Markdown text={readme} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
