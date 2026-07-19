/**
 * AppSettingsPanel — admin UI for the env-var catalog
 * (packages/store/src/app-settings-catalog.ts + migration 105).
 *
 * Category sidebar (master-detail) + accent-insensitive search + i18n
 * (`settings` namespace). Human labels are primary; the raw variable name is a
 * copyable monospace sub-line. Data/mutation logic and subcomponents live in
 * ./app-settings/. Value resolution (db → env → default) is unchanged.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { useAppSettings } from './app-settings/useAppSettings.js';
import { useSettingsFilter } from './app-settings/useSettingsFilter.js';
import { SettingsSidebar } from './app-settings/SettingsSidebar.js';
import { SettingsSearch } from './app-settings/SettingsSearch.js';
import { SettingRow } from './app-settings/SettingRow.js';
import type { SettingCategory } from './app-settings/types.js';

export function AppSettingsPanel() {
  const { t } = useTranslation('settings');
  const {
    data, loading, saving, error, edits,
    setEdit, clearEdit, dirtyCount, restartNeeded, reload, save, restart,
  } = useAppSettings();
  const [activeCategory, setActiveCategory] = useState<SettingCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const filtered = useSettingsFilter({ items: data?.items ?? [], activeCategory, query, showAdvanced });

  useEffect(() => {
    if (activeCategory !== 'all' && !filtered.counts.has(activeCategory)) {
      setActiveCategory('all');
    }
  }, [activeCategory, filtered.counts]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (error && !data) return <div className="text-sm text-destructive p-4">{error}</div>;
  if (!data) return null;

  const total = [...filtered.counts.values()].reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t('chrome.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('chrome.subtitle')}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void reload()}
          disabled={loading || saving}
          title={t('chrome.refresh')}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      <SettingsSearch
        query={query}
        onQuery={setQuery}
        showAdvanced={showAdvanced}
        onShowAdvanced={setShowAdvanced}
        essentialsCount={filtered.essentialsCount}
        advancedCount={filtered.advancedCount}
      />

      <div className="flex gap-6">
        {!filtered.searching && (
          <SettingsSidebar
            categories={data.categories}
            counts={filtered.counts}
            active={activeCategory}
            onSelect={setActiveCategory}
            total={total}
          />
        )}
        <div className="flex-1 min-w-0 rounded-md border bg-card/40 divide-y">
          {filtered.visible.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">{t('chrome.empty')}</div>
          ) : (
            filtered.visible.map((item) => (
              <SettingRow
                key={item.key}
                item={item}
                edit={edits[item.key]}
                onChange={(v) => setEdit(item.key, v)}
                onClear={() => clearEdit(item.key)}
              />
            ))
          )}
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-3 -mb-3 px-3 py-3 bg-background/95 backdrop-blur border-t flex items-center gap-2">
        <div className="text-xs text-muted-foreground flex-1">
          {dirtyCount > 0 ? (
            <span className="inline-flex items-center">
              <Check className="inline h-3 w-3 mr-1 text-emerald-500" />
              {t('chrome.pending', { count: dirtyCount })}
            </span>
          ) : (
            t('chrome.noPending')
          )}
        </div>
        {restartNeeded && (
          <Button variant="outline" size="sm" onClick={() => void restart()}>
            <AlertTriangle className="h-3.5 w-3.5 mr-1.5 text-amber-500" />
            {t('chrome.restartBackend')}
          </Button>
        )}
        <Button size="sm" onClick={() => void save()} disabled={dirtyCount === 0 || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
          {dirtyCount > 0 ? t('chrome.saveCount', { count: dirtyCount }) : t('chrome.save')}
        </Button>
      </div>
    </div>
  );
}
