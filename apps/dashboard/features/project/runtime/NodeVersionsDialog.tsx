/**
 * Manage downloaded Node versions — list installed runtimes (remove the
 * managed ones), and download an official build from nodejs.org with a
 * live progress bar. Binaries are shared across projects (stored under the
 * app data dir). Mirrors the SkillsInstallDialog busy/result pattern.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Progress } from '../../../components/ui/progress.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { apiCall, apiStream } from '../../../lib/api-client.js';
import { useNodeRuntimes, loadNodeRuntimes } from '../../../state/node-runtimes.js';
import type { DownloadProgress, NodeRelease } from '@mcp/api-bus';

interface NodeVersionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NodeVersionsDialog({ open, onOpenChange }: NodeVersionsDialogProps) {
  const { t } = useTranslation(['projects', 'common']);
  const runtimes = useNodeRuntimes((s) => s.runtimes);
  const [releases, setReleases] = useState<NodeRelease[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadNodeRuntimes();
    void apiCall<NodeRelease[]>('runtime.listAvailable', {})
      .then((list) => setReleases(Array.isArray(list) ? list : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  const installed = runtimes.filter((r) => r.isManaged);
  const busy = progress !== null && progress.phase !== 'done';

  async function handleDownload() {
    if (!selected || busy) return;
    setError(null);
    setProgress({ phase: 'download', version: selected });
    try {
      for await (const ev of apiStream<DownloadProgress>('runtime.download', { version: selected })) {
        setProgress(ev);
      }
      await loadNodeRuntimes();
      setProgress(null);
      setSelected('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  }

  async function handleRemove(version: string) {
    setError(null);
    try {
      await apiCall('runtime.remove', { version });
      await loadNodeRuntimes();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const pct =
    progress?.receivedBytes && progress.totalBytes
      ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('runtime.manageTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Installed (managed) */}
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('runtime.installed')}
            </h4>
            {installed.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('runtime.noneInstalled')}</p>
            ) : (
              <ul className="space-y-1">
                {installed.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-mono text-xs">{r.label}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label={t('runtime.remove')}
                      disabled={busy}
                      onClick={() => void handleRemove(r.version)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Download */}
          <div className="border-t pt-4 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('runtime.download')}
            </h4>
            <div className="flex items-center gap-2">
              <Select value={selected} onValueChange={setSelected} disabled={busy}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={t('runtime.pickVersion')} />
                </SelectTrigger>
                <SelectContent>
                  {releases.map((r) => (
                    <SelectItem key={r.version} value={r.version}>
                      v{r.version}
                      {r.lts ? ` · LTS ${r.lts}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" onClick={() => void handleDownload()} disabled={!selected || busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              </Button>
            </div>
            {progress && (
              <div className="space-y-1">
                <Progress value={pct ?? undefined} indeterminate={pct == null} />
                <p className="text-[11px] text-muted-foreground">
                  {progress.phase === 'extract'
                    ? t('runtime.extracting')
                    : t('runtime.downloadingPct', { pct: pct ?? 0 })}
                </p>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">{t('runtime.downloadHint')}</p>
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
