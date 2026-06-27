/**
 * Inline banner shown in the connection dialog for engines whose driver is
 * fetched on demand (Oracle/Mongo/Redis). When the driver isn't installed it
 * offers a one-click download (streaming progress); once present it disappears.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, CheckCircle2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { engineMeta } from '../engines.js';
import * as api from '../api.js';
import type { DbDriverStatus, DbEngine } from '../types.js';

export function DriverInstallGate({ engine }: { engine: DbEngine }) {
  const { t } = useTranslation('dbClient');
  const meta = engineMeta(engine);
  const [status, setStatus] = useState<DbDriverStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [line, setLine] = useState('');

  const refresh = useCallback(async () => {
    const all = await api.driverStatus().catch(() => [] as DbDriverStatus[]);
    setStatus(all.find((s) => s.engine === engine) ?? null);
  }, [engine]);

  useEffect(() => {
    setStatus(null);
    if (meta?.lazyDriver) void refresh();
  }, [engine, meta?.lazyDriver, refresh]);

  if (!meta?.lazyDriver) return null;
  if (status?.installed) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-500">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t('driver.installed')}
      </div>
    );
  }

  async function install(): Promise<void> {
    setInstalling(true);
    setLine('');
    try {
      for await (const f of api.installDriverStream(engine)) {
        if (f.phase === 'log') setLine(f.line);
        else if (f.phase === 'error') toast.error(t('driver.installFailed'), { description: f.message });
        else if (f.phase === 'done') {
          toast.success(t('driver.installed'));
          await refresh();
        }
      }
    } catch (e) {
      toast.error(t('driver.installFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-amber-500" />
        <span className="flex-1 text-muted-foreground">
          {t('driver.needed', { size: status?.sizeLabel ?? '' })}
        </span>
        <Button size="sm" variant="outline" onClick={() => void install()} disabled={installing}>
          {installing && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
          {t('driver.install')}
        </Button>
      </div>
      {installing && line && <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{line}</div>}
    </div>
  );
}
