/**
 * Runtime pane (Node/PHP/Python) — everything for one runtime inline, no nested
 * dialogs: pick the active version, install/remove managed builds (live
 * progress), and (PHP) manage extensions. Consolidates the old
 * RuntimeVersionSelect + RuntimeVersionsDialog + PhpExtensionsSection.
 *
 * Target-aware: the `target` prop (default Host) selects between the host
 * runtimes (node_version / runtime_versions) and a WSL distro's MCP-managed
 * Linux runtimes (wsl_runtime_versions). For a WSL target the selection is
 * keyed by distro and PHP is deferred (Fase 2b).
 *
 * The active selection is controlled by the parent modal (single source), so
 * php/python writes never clobber each other.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Trash2 } from 'lucide-react';
import type { InstallProgress, RuntimeKind, RuntimeRelease, RuntimeTarget } from '@mcp/api-bus';
import type { Project } from '@mcp/shared/types.js';
import { readRuntimeVersion, writeRuntimeVersion } from '@mcp/shared/utils/runtime-versions.js';
import { readWslRuntimeVersion, writeWslRuntimeVersion } from '@mcp/shared/utils/wsl-runtime-versions.js';
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
import { useRuntimes, loadRuntimes, runtimeCacheKey, runtimeTargetKey } from '../../../../state/runtimes.js';
import { PhpExtensionsSection } from '../../runtime/PhpExtensionsSection.js';
import { DependenciesSection } from './DependenciesSection.js';
import type { PatchFn } from '../ProjectSettingsModal.js';

const KIND_LABEL: Record<RuntimeKind, string> = { node: 'Node.js', php: 'PHP', python: 'Python' };
const SYSTEM = 'system';
const HOST: RuntimeTarget = { kind: 'host' };

export function RuntimePane({
  kind,
  project,
  patch,
  target = HOST,
}: {
  kind: RuntimeKind;
  project: Project;
  patch: PatchFn;
  target?: RuntimeTarget;
}) {
  const { t } = useTranslation(['projects', 'common']);
  const isWsl = target.kind === 'wsl';
  const distro = target.kind === 'wsl' ? target.distro : '';
  const key = runtimeCacheKey(kind, target);
  const tkey = runtimeTargetKey(target);
  const runtimes = useRuntimes((s) => s.byKey[key]) ?? [];
  const loaded = useRuntimes((s) => s.loadedKey[key]) ?? false;
  const [releases, setReleases] = useState<RuntimeRelease[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // PHP-in-WSL is deferred (Fase 2b — static-php). Show a notice, nothing else.
  const phpInWsl = isWsl && kind === 'php';

  // Fetch installable releases when the kind/target changes — NOT keyed on
  // `loaded`, which this component itself flips (would double-fetch + flicker).
  useEffect(() => {
    if (phpInWsl) return;
    setReleases([]);
    void apiCall<RuntimeRelease[]>('runtime.listReleases', { kind, target })
      .then((list) => setReleases(Array.isArray(list) ? list : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, tkey, phpInWsl]);
  // Detect installed runtimes once per (kind, target).
  useEffect(() => {
    if (!phpInWsl && !loaded) void loadRuntimes(kind, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded, phpInWsl]);

  const installed = runtimes.filter((r) => r.isManaged);
  const busy = progress !== null && progress.phase !== 'done';

  const activeValue = isWsl
    ? (readWslRuntimeVersion(project.wsl_runtime_versions, distro, kind) ?? null)
    : kind === 'node'
      ? (project.node_version ?? null)
      : (readRuntimeVersion(project.runtime_versions, kind) ?? null);

  function changeActive(next: string): void {
    const id = next === SYSTEM ? null : next;
    if (isWsl) {
      void patch({ wsl_runtime_versions: writeWslRuntimeVersion(project.wsl_runtime_versions, distro, kind, id) });
    } else if (kind === 'node') {
      void patch({ node_version: id });
    } else {
      void patch({ runtime_versions: writeRuntimeVersion(project.runtime_versions, kind, id) });
    }
  }

  async function handleInstall(): Promise<void> {
    if (!selected || busy) return;
    setError(null);
    setProgress({ kind, phase: 'download', version: selected });
    try {
      for await (const ev of apiStream<InstallProgress>('runtime.install', { kind, version: selected, target })) setProgress(ev);
      const list = await loadRuntimes(kind, target);
      // Activate the just-installed build when nothing is chosen yet, so
      // "install" → "active" is one step (matches what the user expects).
      if (!activeValue) {
        const justInstalled = list.find((r) => r.version === selected || r.id === `managed:${selected}`);
        if (justInstalled) changeActive(justInstalled.id);
      }
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
      await apiCall('runtime.uninstall', { kind, version, target });
      await loadRuntimes(kind, target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (phpInWsl) {
    return (
      <div className="space-y-3 max-w-xl">
        <h3 className="text-sm font-semibold">{KIND_LABEL[kind]}</h3>
        <p className="text-sm text-muted-foreground">{t('runtime.wslPhpSoon')}</p>
      </div>
    );
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
            <SelectItem value={SYSTEM}>{isWsl ? t('runtime.wslDistroDefault') : t('runtime.systemDefault')}</SelectItem>
            {runtimes.length > 0 && <SelectSeparator />}
            {runtimes.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{isWsl ? t('runtime.wslHint', { distro }) : t('runtime.nodeHint')}</p>
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
        <p className="text-[11px] text-muted-foreground">{isWsl ? t('runtime.wslInstallHint', { distro }) : t('runtime.installHint')}</p>
      </div>

      <DependenciesSection kind={kind} project={project} patch={patch} target={target} />

      {kind === 'php' && !isWsl && <PhpExtensionsSection installs={installed} />}

      {error && <div className="text-sm text-destructive">{error}</div>}
    </div>
  );
}
