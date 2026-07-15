/**
 * Project Settings — one large modal with a left side-nav, the single home for
 * everything project-scoped: General, Search/Indexing, the per-project runtimes
 * (Node/PHP/Python — select + install/remove + PHP extensions, all inline, no
 * nested dialogs), Terminal (runner shell), Memory, and Danger zone.
 *
 * The modal owns ONE copy of the project (fetched fresh on open) and a single
 * `patch` front-door, so the runtime panes never hold divergent snapshots of
 * the runtime_versions JSON (php/python can't clobber each other). Persistence
 * routes through the normal PATCH; runtime/shell fields land in the per-project
 * DB (migration 168) so they travel with the project folder.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ALargeSmall, Blocks, Braces, Code2, Coffee, Hash, Hexagon, Keyboard, ListTree, Loader2, MemoryStick, Palette, Search, Settings2, Sparkles, TerminalSquare, Trash2 } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import type { RuntimeTarget, TerminalShell } from '@mcp/api-bus';
import { cn } from '../../../lib/utils.js';
import { apiCall } from '../../../lib/api-client.js';
import { apiPatch } from '../../../hooks/useApi.js';
import { Combobox } from '../../../components/ui/combobox.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { WorkbenchPanelHeader } from '../../../components/workbench/index.js';
import { GeneralPane } from './panes/GeneralPane.js';
import { DangerPane } from './panes/DangerPane.js';
import {
  EditorAutocompletePane,
  EditorCodeStylePane,
  EditorGeneralPane,
} from './panes/EditorPreferencesPane.js';

const SearchPane = lazy(() => import('./panes/SearchPane.js').then((module) => ({ default: module.SearchPane })));
const RuntimePane = lazy(() => import('./panes/RuntimePane.js').then((module) => ({ default: module.RuntimePane })));
const TerminalPane = lazy(() => import('./panes/TerminalPane.js').then((module) => ({ default: module.TerminalPane })));
const MemoryPane = lazy(() => import('./panes/MemoryPane.js').then((module) => ({ default: module.MemoryPane })));
const AppearancePane = lazy(() => import('./panes/AppearancePane.js').then((module) => ({ default: module.AppearancePane })));
const EditorThemePane = lazy(() => import('./panes/EditorThemePane.js').then((module) => ({ default: module.EditorThemePane })));
const KeymapPane = lazy(() => import('../../search-everywhere/KeymapDialog.js').then((module) => ({ default: module.KeymapPane })));

export type SettingsSection =
  | 'general'
  | 'search'
  | 'node'
  | 'php'
  | 'python'
  | 'java'
  | 'dotnet'
  | 'terminal'
  | 'memory'
  | 'appearance'
  | 'editorGeneral'
  | 'editorCodeStyle'
  | 'editorAutocomplete'
  | 'editorTheme'
  | 'editorKeymap'
  | 'danger';

export type PatchFn = (body: Record<string, unknown>) => Promise<void>;

interface ProjectSettingsModalProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
  existingGroups?: string[];
  onSaved?: () => void;
  onDeleted?: () => void;
}

export function ProjectSettingsModal({
  project: initialProject,
  open,
  onOpenChange,
  initialSection = 'general',
  existingGroups = [],
  onSaved,
  onDeleted,
}: ProjectSettingsModalProps) {
  const { t } = useTranslation(['projects', 'common']);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [project, setProject] = useState<Project>(initialProject);
  const [error, setError] = useState<string | null>(null);
  // Runtime environment (Host vs a WSL distro) — governs the Node/PHP/Python
  // panes so the same picker can manage a distro's MCP-managed Linux runtimes.
  const [runtimeEnv, setRuntimeEnv] = useState<RuntimeTarget>({ kind: 'host' });
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [wslStatus, setWslStatus] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const isRuntimeSection = section === 'node' || section === 'php' || section === 'python' || section === 'java' || section === 'dotnet';

  // Re-hydrate the freshest project (persisted values) every time we open, and
  // honour the requested entry section.
  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setError(null);
    setRuntimeEnv({ kind: 'host' });
    setWslDistros([]);
    setWslStatus('idle');
    let alive = true;
    void apiCall<Project>('projects.get', { id: initialProject.id })
      .then((p) => { if (alive) setProject(p); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [open, initialSection, initialProject.id]);

  // Shell discovery is useful only for runtime management. Deferring it keeps
  // the common General/Search openings free of an Electron bridge round-trip.
  useEffect(() => {
    if (!open || !isRuntimeSection || wslStatus !== 'idle') return;
    setWslStatus('loading');
    void apiCall<TerminalShell[]>('terminal.listShells', {})
      .then((shells) => {
        setWslDistros((Array.isArray(shells) ? shells : [])
          .filter((shell) => shell.id.startsWith('wsl:'))
          .map((shell) => shell.id.slice('wsl:'.length)));
        setWslStatus('loaded');
      })
      .catch(() => {
        setWslDistros([]);
        setWslStatus('loaded');
      });
  }, [isRuntimeSection, open, wslStatus]);

  const patch = useCallback<PatchFn>(
    async (body) => {
      setError(null);
      setProject((prev) => ({ ...prev, ...body }) as Project); // optimistic
      try {
        await apiPatch(`/projects/${initialProject.id}`, body);
        onSaved?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // Re-sync to the authoritative server state — rolls back the optimistic value.
        void apiCall<Project>('projects.get', { id: initialProject.id }).then(setProject).catch(() => undefined);
      }
    },
    [initialProject.id, onSaved],
  );

  const navGroups = useMemo(() => [
    {
      id: 'project',
      label: t('settings.group.project'),
      items: [
        { id: 'general' as const, label: t('settings.nav.general'), Icon: Settings2 },
        { id: 'search' as const, label: t('settings.nav.search'), Icon: Search },
      ],
    },
    {
      id: 'runtimes',
      label: t('settings.group.runtimes'),
      items: [
        { id: 'node' as const, label: 'Node.js', Icon: Hexagon },
        { id: 'php' as const, label: 'PHP', Icon: Blocks },
        { id: 'python' as const, label: 'Python', Icon: Braces },
        { id: 'java' as const, label: 'Java (JDK)', Icon: Coffee },
        { id: 'dotnet' as const, label: '.NET SDK', Icon: Hash },
        { id: 'terminal' as const, label: t('settings.nav.terminal'), Icon: TerminalSquare },
      ],
    },
    {
      id: 'editor',
      label: 'EDITOR',
      items: [
        { id: 'editorGeneral' as const, label: 'Geral', Icon: Code2 },
        { id: 'editorCodeStyle' as const, label: 'Estilo de código', Icon: ListTree },
        { id: 'editorAutocomplete' as const, label: 'Autocomplete', Icon: Sparkles },
        { id: 'editorTheme' as const, label: t('settings.nav.editorTheme'), Icon: Palette },
        { id: 'editorKeymap' as const, label: 'Keymap', Icon: Keyboard },
      ],
    },
    {
      id: 'experience',
      label: t('settings.group.experience'),
      items: [
        { id: 'memory' as const, label: t('settings.nav.memory'), Icon: MemoryStick },
        { id: 'appearance' as const, label: t('settings.nav.appearance'), Icon: ALargeSmall },
      ],
    },
    {
      id: 'security',
      label: t('settings.group.security'),
      items: [{ id: 'danger' as const, label: t('settings.nav.danger'), Icon: Trash2 }],
    },
  ], [t]);
  const activeNav = navGroups.flatMap((group) => group.items).find((item) => item.id === section)
    ?? navGroups[0]!.items[0]!;
  const runtimeEnvOptions = useMemo(() => [
    { value: 'host', label: t('settings.runtimeEnvHost') },
    ...wslDistros.map((distro) => ({ value: `wsl:${distro}`, label: `WSL: ${distro}` })),
  ], [t, wslDistros]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,92vh)] w-[calc(100vw-32px)] max-w-5xl flex-col gap-0 overflow-hidden border-[var(--workbench-border)] bg-[var(--workbench-surface)] p-0">
        <DialogHeader className="flex h-11 shrink-0 justify-center border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-4 py-0">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 text-sm">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-[var(--workbench-active)] text-violet-400">
              <Settings2 className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{t('settings.title', { name: project.name })}</span>
            <span className="hidden min-w-0 truncate font-mono text-[10px] font-normal text-muted-foreground md:inline">
              {project.root_path}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="w-60 shrink-0 border-r border-[var(--workbench-border)] bg-[var(--workbench-raised)]">
            <nav className="h-full space-y-2 overflow-y-auto p-1.5" aria-label={t('settings.title', { name: project.name })}>
              {navGroups.map((group) => (
                <div key={group.id}>
                  <div className="flex h-6 items-center px-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    {group.label}
                  </div>
                  <div className="space-y-0.5">
                    {group.items.map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSection(id)}
                        aria-current={section === id ? 'page' : undefined}
                        className={cn(
                          'relative flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--workbench-focus)]',
                          section === id
                            ? 'bg-[var(--workbench-active)] font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-[var(--workbench-hover)] hover:text-foreground',
                          id === 'danger' && section !== id && 'text-destructive/80 hover:text-destructive',
                        )}
                      >
                        {section === id && <span className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-r bg-[var(--workbench-focus)]" />}
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col bg-[var(--workbench-surface)]">
            <WorkbenchPanelHeader
              title={activeNav.label}
              icon={activeNav.Icon}
              actions={isRuntimeSection ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">{t('settings.runtimeEnv')}</span>
                  {wslStatus === 'loading' && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  <Combobox
                    disabled={wslStatus === 'loading'}
                    value={runtimeEnv.kind === 'wsl' ? `wsl:${runtimeEnv.distro}` : 'host'}
                    onChange={(value) => setRuntimeEnv(value.startsWith('wsl:')
                      ? { kind: 'wsl', distro: value.slice('wsl:'.length) }
                      : { kind: 'host' })}
                    options={runtimeEnvOptions}
                    searchPlaceholder={t('settings.select.search')}
                    emptyLabel={t('settings.select.empty')}
                    className="h-7 w-52 text-[11px]"
                  />
                </div>
              ) : undefined}
            />

            {error && (
              <div className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              <Suspense fallback={<SettingsPaneLoading label={t('common:actions.loading')} />}>
                {section === 'general' && (
                  <GeneralPane
                    project={project}
                    existingGroups={existingGroups}
                    onSaved={(body) => { setProject((current) => ({ ...current, ...body }) as Project); onSaved?.(); }}
                  />
                )}
                {section === 'search' && <SearchPane project={project} patch={patch} />}
                {section === 'node' && <RuntimePane kind="node" project={project} patch={patch} target={runtimeEnv} />}
                {section === 'php' && <RuntimePane kind="php" project={project} patch={patch} target={runtimeEnv} />}
                {section === 'python' && <RuntimePane kind="python" project={project} patch={patch} target={runtimeEnv} />}
                {section === 'java' && <RuntimePane kind="java" project={project} patch={patch} target={runtimeEnv} />}
                {section === 'dotnet' && <RuntimePane kind="dotnet" project={project} patch={patch} target={runtimeEnv} />}
                {section === 'terminal' && <TerminalPane project={project} patch={patch} />}
                {section === 'memory' && <MemoryPane project={project} patch={patch} />}
                {section === 'appearance' && <AppearancePane />}
                {section === 'editorGeneral' && <EditorGeneralPane projectId={project.id} />}
                {section === 'editorCodeStyle' && <EditorCodeStylePane projectId={project.id} />}
                {section === 'editorAutocomplete' && <EditorAutocompletePane projectId={project.id} />}
                {section === 'editorTheme' && <EditorThemePane />}
                {section === 'editorKeymap' && <KeymapPane className="h-[590px]" />}
                {section === 'danger' && (
                  <DangerPane project={project} onDeleted={() => { onOpenChange(false); onDeleted?.(); }} />
                )}
              </Suspense>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsPaneLoading({ label }: { label: string }) {
  return (
    <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}
