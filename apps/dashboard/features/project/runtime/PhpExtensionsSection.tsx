/**
 * PHP extensions management for managed installs — toggle bundled extensions
 * (rewrites php.ini) and add external/PECL extensions. Only managed installs
 * are listed (we own their php.ini); system/Homebrew PHP is not shown here.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Search } from 'lucide-react';
import type { InstallProgress, PhpExtension, Runtime } from '@mcp/api-bus';
import { Button } from '../../../components/ui/button.js';
import { Combobox } from '../../../components/ui/combobox.js';
import { Input } from '../../../components/ui/input.js';
import { Switch } from '../../../components/ui/switch.js';
import { ScrollArea } from '../../../components/ui/scroll-area.js';
import { apiCall, apiStream } from '../../../lib/api-client.js';
import { filterPhpExtensions } from './php-extension-search.js';

export function PhpExtensionsSection({ installs }: { installs: Runtime[] }) {
  const { t } = useTranslation(['projects', 'common']);
  const [version, setVersion] = useState<string>('');
  const [exts, setExts] = useState<PhpExtension[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [extensionQuery, setExtensionQuery] = useState('');
  const [peclName, setPeclName] = useState('');
  const [busy, setBusy] = useState(false);
  const installOptions = useMemo(
    () => installs.map((install) => ({ value: install.version, label: install.version })),
    [installs],
  );
  const filteredExts = useMemo(
    () => filterPhpExtensions(exts, extensionQuery),
    [exts, extensionQuery],
  );

  // Default to the first managed install; keep it valid as installs change.
  useEffect(() => {
    if (installs.length > 0 && !installs.some((i) => i.version === version)) {
      setVersion(installs[0].version);
    }
  }, [installs, version]);

  async function reload(v: string) {
    if (!v) return;
    setError(null);
    try {
      setExts(await apiCall<PhpExtension[]>('runtime.listExtensions', { version: v }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    setExtensionQuery('');
    void reload(version);
  }, [version]);

  async function toggle(name: string, enabled: boolean) {
    setError(null);
    try {
      await apiCall('runtime.setExtension', { version, name, enabled });
      await reload(version);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function addPecl() {
    const name = peclName.trim().toLowerCase();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      for await (const _ev of apiStream<InstallProgress>('runtime.installPeclExtension', { version, name })) {
        /* progress frames — completion is enough for this compact UI */
      }
      setPeclName('');
      await reload(version);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (installs.length === 0) {
    return (
      <div className="border-t pt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('runtime.extensions')}
        </h4>
        <p className="mt-1 text-[11px] text-muted-foreground">{t('runtime.extensionsManagedOnly')}</p>
      </div>
    );
  }

  return (
    <div className="border-t pt-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('runtime.extensions')}
        </h4>
        {installs.length > 1 && (
          <Combobox
            value={version}
            onChange={setVersion}
            options={installOptions}
            searchPlaceholder={t('settings.select.search')}
            emptyLabel={t('settings.select.empty')}
            className="h-7 w-40 text-xs"
          />
        )}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={extensionQuery}
          onChange={(event) => setExtensionQuery(event.target.value)}
          placeholder={t('runtime.extensionSearch')}
          aria-label={t('runtime.extensionSearch')}
          className="h-8 pl-8 text-xs"
        />
      </div>

      <ScrollArea className="h-40 rounded border">
        {extensionQuery.trim() && filteredExts.length === 0 ? (
          <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
            {t('runtime.extensionsNoMatch')}
          </div>
        ) : (
          <ul className="divide-y">
            {filteredExts.map((ext) => (
              <li key={ext.name} className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
                <span className="flex items-center gap-1.5 font-mono text-xs">
                  {ext.name}
                  {ext.loaded && <span className="text-[10px] text-emerald-500">●</span>}
                </span>
                <Switch
                  checked={ext.enabled}
                  disabled={busy}
                  onCheckedChange={(v: boolean) => void toggle(ext.name, v)}
                  aria-label={ext.name}
                />
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      <div className="space-y-1.5 border-t pt-2.5">
        <label className="text-xs font-medium">{t('runtime.extensionPeclLabel')}</label>
        <div className="flex items-center gap-2">
          <Input
            value={peclName}
            onChange={(e) => setPeclName(e.target.value)}
            placeholder={t('runtime.extensionPlaceholder')}
            aria-label={t('runtime.extensionPeclLabel')}
            className="h-8 flex-1 text-xs"
            disabled={busy}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void addPecl()}
            disabled={!peclName.trim() || busy}
            aria-label={t('runtime.extensionPeclInstall')}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('runtime.extensionsHint')}</p>

      {error && <div className="text-sm text-destructive">{error}</div>}
    </div>
  );
}
