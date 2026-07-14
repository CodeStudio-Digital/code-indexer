/**
 * PHP extensions management for managed installs — toggle bundled extensions
 * (rewrites php.ini) and add external/PECL extensions. Only managed installs
 * are listed (we own their php.ini); system/Homebrew PHP is not shown here.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus } from 'lucide-react';
import type { InstallProgress, PhpExtension, Runtime } from '@mcp/api-bus';
import { Button } from '../../../components/ui/button.js';
import { Combobox } from '../../../components/ui/combobox.js';
import { Input } from '../../../components/ui/input.js';
import { Switch } from '../../../components/ui/switch.js';
import { ScrollArea } from '../../../components/ui/scroll-area.js';
import { apiCall, apiStream } from '../../../lib/api-client.js';

export function PhpExtensionsSection({ installs }: { installs: Runtime[] }) {
  const { t } = useTranslation(['projects', 'common']);
  const [version, setVersion] = useState<string>('');
  const [exts, setExts] = useState<PhpExtension[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [peclName, setPeclName] = useState('');
  const [busy, setBusy] = useState(false);
  const installOptions = useMemo(
    () => installs.map((install) => ({ value: install.version, label: install.version })),
    [installs],
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

      <ScrollArea className="h-40 rounded border">
        <ul className="divide-y">
          {exts.map((ext) => (
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
      </ScrollArea>

      <div className="flex items-center gap-2">
        <Input
          value={peclName}
          onChange={(e) => setPeclName(e.target.value)}
          placeholder={t('runtime.extensionPlaceholder')}
          className="h-8 flex-1 text-xs"
          disabled={busy}
        />
        <Button type="button" size="sm" onClick={() => void addPecl()} disabled={!peclName.trim() || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('runtime.extensionsHint')}</p>

      {error && <div className="text-sm text-destructive">{error}</div>}
    </div>
  );
}
