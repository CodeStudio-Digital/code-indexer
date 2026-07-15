/**
 * Dependency assistant for one runtime (Node/PHP/Python) inside the RuntimePane:
 * pick the package manager (Node: npm/yarn/pnpm/bun · Python: pip/Poetry · PHP:
 * composer, fixed), see whether deps + the tool are present, and install/update
 * with one click. The chosen manager is persisted (package_managers) and the
 * backend `runner.detect` honours it — so the editor gutter + Runners banner
 * follow suit. Runs reveal the Runners tab via `launchRun`.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Download, Plus, RefreshCw, Search } from 'lucide-react';
import type { DetectedGroup, DetectedRunners, ManagerStatus, PackageSearchResult, RuntimeKind, RuntimeTarget } from '@mcp/api-bus';
import type { Project } from '@mcp/shared/types.js';
import { readPackageManager, writePackageManager } from '@mcp/shared/utils/package-managers.js';
import { readWslPackageManager, writeWslPackageManager, type WslPackageManagerKey } from '@mcp/shared/utils/wsl-package-managers.js';
import { Button } from '../../../../components/ui/button.js';
import { Combobox } from '../../../../components/ui/combobox.js';
import { Input } from '../../../../components/ui/input.js';
import { apiCall } from '../../../../lib/api-client.js';
import { launchRun } from '../../../../state/run-launch.js';
import { MANAGER_KEY, MANAGER_OPTIONS, MANAGERS_FOR_KIND, updateCommand } from '../../../../lib/pkg-manager-cmds.js';
import type { PatchFn } from '../ProjectSettingsModal.js';

const HOST: RuntimeTarget = { kind: 'host' };

export function DependenciesSection({
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
  const [group, setGroup] = useState<DetectedGroup | null>(null);
  const [status, setStatus] = useState<ManagerStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Bumped AFTER a manager change persists — `runner.detect` reads the stored
  // override server-side, so re-detecting only on the optimistic prop change
  // could race ahead of the PATCH write and report the old manager.
  const [tick, setTick] = useState(0);
  const [packageQuery, setPackageQuery] = useState('');
  const [packageResults, setPackageResults] = useState<PackageSearchResult[]>([]);
  const [packageBusy, setPackageBusy] = useState(false);
  const [packageMessage, setPackageMessage] = useState<string | null>(null);
  const [packageProjectFile, setPackageProjectFile] = useState('');

  const isWsl = target.kind === 'wsl';
  const distro = target.kind === 'wsl' ? target.distro : '';
  const tgtKey = isWsl ? `wsl:${distro}` : 'host';
  const key = MANAGER_KEY[kind];
  const selected =
    (key
      ? isWsl
        ? readWslPackageManager(project.wsl_package_managers, distro, key as WslPackageManagerKey)
        : readPackageManager(project.package_managers, key)
      : undefined) ?? 'auto';
  const managerOptions = useMemo(() => MANAGER_OPTIONS[kind].map((manager) => ({
    value: manager,
    label: manager === 'auto' ? t('runtime.deps.auto') : manager,
  })), [kind, t]);

  // Detect the group for this runtime. Keyed on `tick` (bumped AFTER a manager
  // change persists), NOT on the optimistic project.package_managers — detect
  // reads the stored override server-side, so re-running on the optimistic prop
  // would fire a wasted pre-persist fetch that reads the old value.
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void apiCall<DetectedRunners>('runner.detect', { projectId: project.id, target })
      .then((d) => {
        if (!alive) return;
        setGroup(d.groups.find((g) => MANAGERS_FOR_KIND[kind].includes(g.manager)) ?? null);
        setLoaded(true);
      })
      .catch(() => { if (alive) { setGroup(null); setLoaded(true); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, project.id, tgtKey, tick]);

  // Is the chosen manager actually on PATH? (warn before an install would fail.)
  useEffect(() => {
    if (!group) { setStatus(null); return; }
    let alive = true;
    setStatus(null);
    void apiCall<ManagerStatus>('runner.managerStatus', { projectId: project.id, manager: group.manager, target })
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { if (alive) setStatus(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.manager, project.id, tgtKey]);

  async function changeManager(next: string): Promise<void> {
    if (!key) return;
    if (isWsl) {
      await patch({ wsl_package_managers: writeWslPackageManager(project.wsl_package_managers, distro, key as WslPackageManagerKey, next) });
    } else {
      await patch({ package_managers: writePackageManager(project.package_managers, key, next) });
    }
    setTick((n) => n + 1); // re-detect once the new override is persisted
  }
  function install(): void {
    if (group?.installCommand) {
      void launchRun({ projectId: project.id, command: group.installCommand, label: t('runtime.deps.install'), manager: group.manager, target });
    }
  }
  function update(): void {
    if (group) {
      void launchRun({ projectId: project.id, command: group.updateCommand ?? updateCommand(group.manager), label: t('runtime.deps.update'), manager: group.manager, target });
    }
  }
  const packageManager = group && (group.manager === 'maven' || group.manager === 'gradle' || group.manager === 'dotnet')
    ? group.manager
    : null;
  const dotnetProjects = useMemo(() => group?.manager === 'dotnet'
    ? group.runners.flatMap((runner) => runner.id.startsWith('dotnet:run:') ? [runner.id.slice('dotnet:run:'.length)] : [])
    : [], [group]);
  const selectedProjectFile = dotnetProjects.length === 1
    ? dotnetProjects[0]
    : dotnetProjects.includes(packageProjectFile) ? packageProjectFile : '';
  const projectFileRequired = packageManager === 'dotnet' && !selectedProjectFile;
  async function searchPackage(): Promise<void> {
    if (!packageManager || packageQuery.trim().length < 2) return;
    setPackageBusy(true);
    setPackageMessage(null);
    try {
      setPackageResults(await apiCall<PackageSearchResult[]>('runner.searchPackages', {
        projectId: project.id,
        manager: packageManager,
        query: packageQuery.trim(),
      }));
    } catch (err) {
      setPackageResults([]);
      setPackageMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPackageBusy(false);
    }
  }
  async function addPackage(item: PackageSearchResult): Promise<void> {
    if (!packageManager) return;
    setPackageBusy(true);
    setPackageMessage(null);
    try {
      const result = await apiCall<{ changed: boolean; manifest: string; message?: string }>('runner.addDependency', {
        projectId: project.id,
        manager: packageManager,
        packageId: item.id,
        version: item.version,
        projectFile: packageManager === 'dotnet' ? selectedProjectFile || undefined : undefined,
        target,
      });
      setPackageMessage(result.changed
        ? t('runtime.deps.packageAdded', { package: item.id, manifest: result.manifest })
        : (result.message ?? t('runtime.deps.packagePresent')));
    } catch (err) {
      setPackageMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPackageBusy(false);
    }
  }

  return (
    <div className="border-t pt-4 space-y-2.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('runtime.deps.title')}</h4>

      {!loaded ? null : !group ? (
        <p className="text-[11px] text-muted-foreground">{t('runtime.deps.noManifest')}</p>
      ) : (
        <>
          {/* Manager picker (Node/Python) or fixed composer label (PHP). */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('runtime.deps.manager')}</label>
            {key ? (
              <Combobox
                value={selected}
                onChange={(value) => void changeManager(value)}
                options={managerOptions}
                searchPlaceholder={t('settings.select.search')}
                emptyLabel={t('settings.select.empty')}
              />
            ) : (
              <p className="font-mono text-xs capitalize">{group.manager}</p>
            )}
          </div>

          {/* Status: deps present + tool availability. */}
          <div className="space-y-1 text-[11px]">
            <span className="flex items-center gap-1.5">
              {group.installNeeded ? (
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              )}
              <span className="text-muted-foreground">
                {group.installNeeded ? t('runtime.deps.missing') : t('runtime.deps.installed')}
              </span>
            </span>
            {status && !status.found && (
              <span className="flex items-center gap-1.5 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t('runtime.deps.notFound', { manager: group.manager })}
              </span>
            )}
          </div>

          {/* Actions — gated when the manager is confirmed missing from PATH
              (a run would just fail with "command not found"; the warning above
              explains why). `status === null` = still probing → stay enabled. */}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={install} disabled={!group.installCommand || (!!status && !status.found)}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t('runtime.deps.install')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={update} disabled={!!status && !status.found}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('runtime.deps.update')}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('runtime.deps.hint')}</p>
          {packageManager && (
            <div className="space-y-2 border-t pt-2.5">
              {packageManager === 'dotnet' && dotnetProjects.length > 1 && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('runtime.deps.projectFile')}</label>
                  <Combobox
                    value={packageProjectFile}
                    onChange={setPackageProjectFile}
                    options={dotnetProjects.map((file) => ({ value: file, label: file }))}
                    searchPlaceholder={t('runtime.deps.projectFileSearch')}
                    emptyLabel={t('settings.select.empty')}
                  />
                </div>
              )}
              {packageManager === 'dotnet' && dotnetProjects.length === 0 && (
                <p className="text-[11px] text-muted-foreground">{t('runtime.deps.noProjectFile')}</p>
              )}
              <div className="flex gap-2">
                <Input
                  value={packageQuery}
                  onChange={(event) => setPackageQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void searchPackage(); }}
                  placeholder={t('runtime.deps.packageSearch')}
                  className="h-8 text-xs"
                />
                <Button type="button" size="sm" variant="outline" onClick={() => void searchPackage()} disabled={packageBusy || packageQuery.trim().length < 2}>
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </div>
              {packageResults.slice(0, 8).map((item) => (
                <div key={`${item.id}@${item.version}`} className="flex items-start gap-2 rounded border p-2 text-[11px]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono">{item.id}</div>
                    <div className="text-muted-foreground">{item.version}</div>
                    {item.description && <div className="line-clamp-2 text-muted-foreground">{item.description}</div>}
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void addPackage(item)} disabled={packageBusy || projectFileRequired}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {packageMessage && <p className="text-[11px] text-muted-foreground">{packageMessage}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
