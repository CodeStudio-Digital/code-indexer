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

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ALargeSmall, Blocks, Braces, Hexagon, MemoryStick, Palette, Search, Settings2, TerminalSquare, Trash2 } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import type { RuntimeTarget, TerminalShell } from '@mcp/api-bus';
import { cn } from '../../../lib/utils.js';
import { apiCall } from '../../../lib/api-client.js';
import { apiPatch } from '../../../hooks/useApi.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.js';
import { GeneralPane } from './panes/GeneralPane.js';
import { SearchPane } from './panes/SearchPane.js';
import { RuntimePane } from './panes/RuntimePane.js';
import { TerminalPane } from './panes/TerminalPane.js';
import { MemoryPane } from './panes/MemoryPane.js';
import { AppearancePane } from './panes/AppearancePane.js';
import { EditorThemePane } from './panes/EditorThemePane.js';
import { DangerPane } from './panes/DangerPane.js';

export type SettingsSection =
  | 'general'
  | 'search'
  | 'node'
  | 'php'
  | 'python'
  | 'terminal'
  | 'memory'
  | 'appearance'
  | 'editorTheme'
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

  // Re-hydrate the freshest project (persisted values) every time we open, and
  // honour the requested entry section.
  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setError(null);
    setRuntimeEnv({ kind: 'host' });
    let alive = true;
    void apiCall<Project>('projects.get', { id: initialProject.id })
      .then((p) => { if (alive) setProject(p); })
      .catch(() => undefined);
    // Detected WSL distros become the non-Host runtime environments.
    void apiCall<TerminalShell[]>('terminal.listShells', {})
      .then((shells) => {
        if (!alive) return;
        const distros = (Array.isArray(shells) ? shells : [])
          .filter((s) => s.id.startsWith('wsl:'))
          .map((s) => s.id.slice('wsl:'.length));
        setWslDistros(distros);
      })
      .catch(() => { if (alive) setWslDistros([]); });
    return () => { alive = false; };
  }, [open, initialSection, initialProject.id]);

  const isRuntimeSection = section === 'node' || section === 'php' || section === 'python';

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

  const NAV: { id: SettingsSection; label: string; Icon: typeof Hexagon }[] = [
    { id: 'general', label: t('settings.nav.general'), Icon: Settings2 },
    { id: 'search', label: t('settings.nav.search'), Icon: Search },
    { id: 'node', label: 'Node.js', Icon: Hexagon },
    { id: 'php', label: 'PHP', Icon: Blocks },
    { id: 'python', label: 'Python', Icon: Braces },
    { id: 'terminal', label: t('settings.nav.terminal'), Icon: TerminalSquare },
    { id: 'memory', label: t('settings.nav.memory'), Icon: MemoryStick },
    { id: 'appearance', label: t('settings.nav.appearance'), Icon: ALargeSmall },
    { id: 'editorTheme', label: t('settings.nav.editorTheme'), Icon: Palette },
    { id: 'danger', label: t('settings.nav.danger'), Icon: Trash2 },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[88vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            {t('settings.title', { name: project.name })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 h-[70vh]">
          <nav className="w-52 shrink-0 border-r p-2 space-y-0.5 overflow-y-auto bg-muted/20">
            {NAV.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={section === id ? 'page' : undefined}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 rounded-md text-sm flex items-center gap-2 transition-colors',
                  section === id
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted/50',
                  id === 'danger' && section !== id && 'text-destructive/80 hover:text-destructive',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </nav>
          <div className="flex-1 min-w-0 overflow-y-auto p-4">
            {error && (
              <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            {isRuntimeSection && wslDistros.length > 0 && (
              <div className="mb-4 flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground shrink-0">{t('settings.runtimeEnv')}</label>
                <Select
                  value={runtimeEnv.kind === 'wsl' ? `wsl:${runtimeEnv.distro}` : 'host'}
                  onValueChange={(v) => setRuntimeEnv(v.startsWith('wsl:') ? { kind: 'wsl', distro: v.slice('wsl:'.length) } : { kind: 'host' })}
                >
                  <SelectTrigger className="h-8 w-60"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="host">{t('settings.runtimeEnvHost')}</SelectItem>
                    {wslDistros.map((d) => (
                      <SelectItem key={d} value={`wsl:${d}`}>{`WSL: ${d}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {section === 'general' && (
              <GeneralPane
                project={project}
                existingGroups={existingGroups}
                onSaved={(body) => { setProject((p) => ({ ...p, ...body }) as Project); onSaved?.(); }}
              />
            )}
            {section === 'search' && <SearchPane project={project} patch={patch} />}
            {section === 'node' && <RuntimePane kind="node" project={project} patch={patch} target={runtimeEnv} />}
            {section === 'php' && <RuntimePane kind="php" project={project} patch={patch} target={runtimeEnv} />}
            {section === 'python' && <RuntimePane kind="python" project={project} patch={patch} target={runtimeEnv} />}
            {section === 'terminal' && <TerminalPane project={project} patch={patch} />}
            {section === 'memory' && <MemoryPane project={project} patch={patch} />}
            {section === 'appearance' && <AppearancePane />}
            {section === 'editorTheme' && <EditorThemePane />}
            {section === 'danger' && (
              <DangerPane project={project} onDeleted={() => { onOpenChange(false); onDeleted?.(); }} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
