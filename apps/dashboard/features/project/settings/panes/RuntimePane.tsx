/**
 * Runtime pane (Node/PHP/Python) — everything for one runtime inline, no nested
 * dialogs: pick the active version, install/remove managed builds (live
 * progress), and (PHP) manage extensions. Consolidates the old
 * RuntimeVersionSelect + RuntimeVersionsDialog + PhpExtensionsSection.
 *
 * The active selection is controlled by the parent modal (single source), so
 * php/python writes into runtime_versions never clobber each other.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Trash2 } from 'lucide-react';
import type { InstallProgress, RuntimeKind, RuntimeRelease } from '@mcp/api-bus';
import type { Project } from '@mcp/shared/types.js';
import { readRuntimeVersion, writeRuntimeVersion } from '@mcp/shared/utils/runtime-versions.js';
import { Button } from '../../../../components/ui/button.js';
import { Progress } from '../../../../components/ui/progress.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../../../components/ui/select.js';
import { apiCall, apiStream } from '../../../../lib/api-client.js';
import { useRuntimes, loadRuntimes } from '../../../../state/runtimes.js';
import { PhpExtensionsSection } from '../../runtime/PhpExtensionsSection.js';
import { DependenciesSection } from './DependenciesSection.js';
import type { PatchFn } from '../ProjectSettingsModal.js';

const KIND_LABEL: Record<RuntimeKind, string> = { node: 'Node.js', php: 'PHP', python: 'Python' };
const SYSTEM = 'system';

export function RuntimePane({ kind, project, patch }: { kind: RuntimeKind; project: Project; patch: PatchFn }) {
  const { t } = useTranslation(['projects', 'common']);
  const runtimes = useRuntimes((s) => s.byKind[kind]);
  const loaded = useRuntimes((s) => s.loaded[kind]);
  const [releases, setReleases] = useState<RuntimeRelease[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch installable releases when the KIND changes — NOT keyed on `loaded`,
  // which this component itself flips (would double-fetch + flicker the list).
  useEffect(() => {
    setReleases([]);
    void apiCall<RuntimeRelease[]>('runtime.listReleases', { kind })
      .then((list) => setReleases(Array.isArray(list) ? list : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [kind]);
  // Detect installed runtimes once per kind.
  useEffect(() => {
    if (!loaded) void loadRuntimes(kind);
  }, [kind, loaded]);

  const installed = runtimes.filter((r) => r.isManaged);
  const busy = progress !== null && progress.phase !== 'done';

  const activeValue = kind === 'node' ? (project.node_version ?? null) : (readRuntimeVersion(project.runtime_versions, kind) ?? null);

  function changeActive(next: string): void {
    const id = next === SYSTEM ? null : next;
    if (kind === 'node') void patch({ node_version: id });
    else void patch({ runtime_versions: writeRuntimeVersion(project.runtime_versions, kind, id) });
  }

  async function handleInstall(): Promise<void> {
    if (!selected || busy) return;
    setError(null);
    setProgress({ kind, phase: 'download', version: selected });
    try {
      for await (const ev of apiStream<InstallProgress>('runtime.install', { kind, version: selected })) setProgress(ev);
      await loadRuntimes(kind);
      setProgress(null);
      setSelected('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  }

  async function handleRemove(version: string): Promise<void> {
    setError(null);
    try {
      await apiCall('runtime.uninstall', { kind, version });
      await loadRuntimes(kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const pct = progress?.receivedBytes && progress.totalBytes ? Math.round((progress.receivedBytes / progress.totalBytes) * 100) : null;
  const progressLabel = (): string => {
    if (!progress) return '';
    if (progress.phase === 'extract') return t('runtime.extracting');
    if (progress.phase === 'install' || progress.phase === 'log') return progress.line || t('runtime.installing');
    return t('runtime.downloadingPct', { pct: pct ?? 0 });
  };

  return (
    <div className="space-y-5 max-w-xl">
      <h3 className="text-sm font-semibold">{KIND_LABEL[kind]}</h3>

      {/* Active version */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('runtime.activeVersion')}</label>
        <Select value={activeValue ?? SYSTEM} onValueChange={changeActive}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SYSTEM}>{t('runtime.systemDefault')}</SelectItem>
            {runtimes.length > 0 && <SelectSeparator />}
            {runtimes.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('runtime.nodeHint')}</p>
      </div>

      {/* Installed (managed) */}
      <div className="border-t pt-4 space-y-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('runtime.installed')}</h4>
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

      {/* Install */}
      <div className="border-t pt-4 space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('runtime.install')}</h4>
        <div className="flex items-center gap-2">
          <Select value={selected} onValueChange={setSelected} disabled={busy}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder={t('runtime.pickVersion')} />
            </SelectTrigger>
            <SelectContent>
              {releases.map((r) => (
                <SelectItem key={r.version} value={r.version}>
                  {r.label ? `${r.label} · ${r.version}` : r.version}
                  {r.lts ? ` · LTS ${r.lts}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" onClick={() => void handleInstall()} disabled={!selected || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          </Button>
        </div>
        {progress && (
          <div className="space-y-1">
            <Progress value={pct ?? undefined} indeterminate={pct == null} />
            <p className="truncate text-[11px] text-muted-foreground">{progressLabel()}</p>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">{t('runtime.installHint')}</p>
      </div>

      <DependenciesSection kind={kind} project={project} patch={patch} />

      {kind === 'php' && <PhpExtensionsSection installs={installed} />}

      {error && <div className="text-sm text-destructive">{error}</div>}
    </div>
  );
}
