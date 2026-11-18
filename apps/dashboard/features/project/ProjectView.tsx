/**
 * Project view — the unified IDE-style surface at `/projects/:id`.
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │  AppShell topbar (Projetos / Agentes / Admin / ...)         │   ← global nav (visible)
 *  ├─┬───────────────────────────────────────────────────────────┤
 *  │R│  PanelGroup vertical                                       │
 *  │a│  ┌─────────────────────────────────────────────────────┐  │
 *  │i│  │  Active tab content (depends on rail selection)     │  │
 *  │l│  │   - files → FileTreeRail | EditorPane (split)       │  │
 *  │ │  │   - git   → GitWindow    | EditorPane (split)       │  │
 *  │ │  │   - chat  → AgentChat                               │  │
 *  │ │  │   - search, snapshots, deps, arch, diff, costs, runs│  │
 *  │ │  └─────────────────────────────────────────────────────┘  │
 *  │ │  ─── resize handle (only when bottom panel open) ──────  │
 *  │ │  ┌─────────────────────────────────────────────────────┐  │
 *  │ │  │  BottomPanel — Terminal / Problems / Output         │  │
 *  │ │  └─────────────────────────────────────────────────────┘  │
 *  ├─┴───────────────────────────────────────────────────────────┤
 *  │  StatusBar — git branch · file · counts · LSP indicator     │
 *  └─────────────────────────────────────────────────────────────┘
 *
 * Replaces both the standalone JetBrains-style Workspace AND the old
 * ProjectDetail analytics tabs into a single screen. The rail is the
 * navigation primitive: each icon shows a different "tool window" in
 * the central area. The bottom panel (terminal) is independent of the
 * active rail tab — it toggles via Ctrl+J or the rail's footer icon.
 *
 * State reuse:
 *   - `useWorkspaceStore`        → open files / active file / dirty marks
 *   - `useWorkspaceLayout`       → bottom-panel toggle + size persistence
 *   - `loadPersistedTabs`        → restore tabs across reloads
 *
 * Layout assumptions:
 *   - Mounted INSIDE AppShell chrome (no h-100dvh; we get flex-1 from
 *     AppShell's `<main>`). The AppShell topbar stays visible above us.
 *   - The `useWorkspaceLayout` store's `activeBottom` is the canonical
 *     "is the terminal open?" signal — reused 1:1 from the workspace
 *     experience so the user's preference persists across project
 *     switches.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import type { Project } from '@mcp/shared/types.js';
import { useRunningTasks, tasksForProject, isDevServerTask } from '../../state/running-tasks.js';
import {
  savePersistedTabs,
  useWorkspaceStore,
} from '../../state/workspace.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { useWorktreeSelection } from '../../state/worktree-selection.js';
import { pushRecentProject } from '../../state/recent-projects.js';
import { useContributions, hydrateContributions } from '../../state/contribution-registry.js';
import { useFsEvents, type FsEventDTO } from '../../hooks/useFsEvents.js';
import { useGitMeta } from '../../hooks/useGitMeta.js';
import { useGitRevision } from '../../state/git-revision.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { useTranslation } from 'react-i18next';
import { useFileTreeStore } from '../../state/file-tree.js';
import { apiCall as apiCallFs } from '../../lib/api-client.js';
import { markRouteEvent, setRouteTab } from '../../lib/perf/route-startup-metrics.js';
import { useActiveSurface } from '../../state/active-surface.js';
import { registerProjectCommands } from './project-commands.js';
import { registerEditorCommands } from '../workspace/editor/editor-commands.js';
import { registerCommands } from '../../keymap/commands.js';
import { apiCall } from '../../lib/api-client.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import {
  matchesEditorDocument,
  pluginEditorContextFromEditor,
} from '../workspace/editor/plugin-editor-gutter.js';
import { runPluginEditorAction } from '../workspace/editor/plugin-editor-action-runner.js';
import { flushWorkspaceDrafts, getActiveEditor } from '../workspace/editor/editor-models.js';
import { startRecentFilesTracking } from '../../state/recent-files.js';
import { SearchEverywhere } from '../search-everywhere/SearchEverywhere.js';
import { FileStructurePopup } from '../search-everywhere/FileStructurePopup.js';
import { KeymapDialog } from '../search-everywhere/KeymapDialog.js';
import { LocalHistoryDialog } from '../workspace/local-history/LocalHistoryDialog.js';
import { BOTTOM_BUILTIN_TAB_IDS } from '../workspace/BottomPanel.js';
import { projectSurface } from './tabs-config.js';
import { ProjectWorkbench } from './ProjectWorkbench.js';
import { useProjectCheckout } from './useProjectCheckout.js';

interface ProjectViewProps {
  projectId: number;
  projectName: string;
  /** When set (via Recent Sessions click in AppShell topbar), pre-selects
   *  the chat tab + the given session inside AgentChat. */
  initialSessionId?: string;
}

export function ProjectView({ projectId, projectName, initialSessionId }: ProjectViewProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation('workspace');
  const layout = useWorkspaceLayout();
  const clearCheckoutLink = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('session') && !params.has('worktree')) return;
    params.delete('session');
    params.delete('worktree');
    navigate({ search: params.toString(), hash: location.hash }, { replace: true });
  }, [location.hash, location.search, navigate]);
  const worktreeSelection = useWorktreeSelection(projectId, clearCheckoutLink);
  const linkedWorktree = new URLSearchParams(location.search).get('worktree');
  const selectWorktree = worktreeSelection.select;
  useLayoutEffect(() => {
    if (linkedWorktree !== null) selectWorktree(linkedWorktree || null);
  }, [linkedWorktree, selectWorktree]);
  const { workspaceId, workspaceRoot, workspaceError } = useProjectCheckout(projectId, worktreeSelection.path);
  const contribWindows = useContributions((s) => s.toolWindows);
  const contribEditorActions = useContributions((s) => s.editorActions);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const activeFilePath = useWorkspaceStore((s) =>
    workspaceId != null && s.activeProjectId === workspaceId ? s.activeFilePath : null);
  const setProject = useWorkspaceStore((s) => s.setProject);

  // Live filesystem events — ONE stream per project feeds both consumers:
  // the lazy file tree (incremental upsert/delete) and the open tabs
  // (non-dirty → silent reload from disk; dirty → conflict badge).
  const applyFsEventsToTree = useFileTreeStore((s) => s.applyFsEvents);
  const gitFsDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useFsEvents(workspaceId, (events: FsEventDTO[]) => {
    const ws = useWorkspaceStore.getState();
    if (workspaceId == null || ws.activeProjectId !== workspaceId) return;
    if (useFileTreeStore.getState().projectId === workspaceId) applyFsEventsToTree(events);
    if (events.some((event) => !event.isDir)) {
      if (gitFsDebounce.current) clearTimeout(gitFsDebounce.current);
      gitFsDebounce.current = setTimeout(() => {
        const revision = useGitRevision.getState();
        revision.bump(workspaceId, revision.branchByProject[workspaceId] ?? null);
      }, 350);
    }
    for (const e of events) {
      if (e.isDir) continue;
      const tab = ws.openFiles.find(
        (f) => (f.kind === undefined || f.kind === 'file') && f.path === e.path && f.projectId === workspaceId,
      );
      if (!tab || (tab.kind !== undefined && tab.kind !== 'file')) continue;
      if (e.kind === 'delete' || tab.dirty) {
        ws.markExternallyChanged(workspaceId, e.path);
        continue;
      }
      // Never-loaded tab (content null) loads on activation anyway.
      if (tab.content === null) continue;
      // External change on a clean, loaded tab — refresh silently via the
      // live-model patcher (pushEditOperations keeps the undo stack). Our
      // own saves echo here too; ifModifiedSince makes that a stat-only
      // round trip with no payload.
      void apiCallFs<
        { content: string; last_modified: string } | { notModified: true; last_modified: string }
      >('files.read', { projectId: workspaceId, path: e.path, ifModifiedSince: tab.lastModified ?? undefined })
        .then(async (res) => {
          if ('notModified' in res) return;
          const { applyExternalContent } = await import('../workspace/editor/editor-models.js');
          applyExternalContent(workspaceId, e.path, res.content, res.last_modified);
        })
        .catch(() => undefined);
    }
  });
  useEffect(() => () => {
    if (gitFsDebounce.current) clearTimeout(gitFsDebounce.current);
  }, [workspaceId]);

  // Live git-metadata — ONE stream per project. A branch switch (in-app OR an
  // external `git checkout`) bumps the git-revision store, which re-syncs the
  // branch chip / git window / file-tree colors; a genuine switch also toasts.
  // Editor contents already self-heal via the fs-events stream above (the
  // working-tree files change on disk), and the backend re-indexes on its own.
  useGitMeta(workspaceId, (frame) => {
    if (workspaceId == null) return;
    // changed:[] marks the server seed (initial/reconnect snapshot) — record the
    // branch without forcing a refetch unless it reveals a switch we missed.
    const isSeed = frame.changed.length === 0;
    const { branchChanged } = useGitRevision.getState().bump(workspaceId, frame.branch, isSeed);
    if (branchChanged) {
      window.dispatchEvent(new CustomEvent('coder:worktrees-changed', { detail: { projectId } }));
      toast.info(frame.branch ? t('git.branchSwitched', { branch: frame.branch }) : t('git.branchDetached'));
    }
  });

  // Builder project? Read `builder_json` to enable the live-preview pane
  // beside the chat. Null/parse-fail → ordinary project (no preview).
  const { data: project } = useApi<Project>(`/projects/${projectId}`);
  const builderJson = useMemo<{ stack: string; port: number } | null>(() => {
    if (!project?.builder_json) return null;
    try {
      const cfg = JSON.parse(project.builder_json) as { stack?: string; port?: number };
      return cfg.stack && cfg.port ? { stack: cfg.stack, port: cfg.port } : null;
    } catch {
      return null;
    }
  }, [project?.builder_json]);

  // Preview availability: builder projects always; any project once a
  // dev-server runner is active. Drives both the conditional "Preview" rail
  // tab and the chat-tab split.
  const hasDevTask = useRunningTasks((s) => tasksForProject(s.tasks, projectId, worktreeSelection.path).some(isDevServerTask));
  const previewEnabled = workspaceId != null && (!!builderJson || hasDevTask);
  // Keep project metadata reads side-effect free. The explicit lifecycle call
  // runs after the first paint and is cancelled if this view disappears before
  // the deferred large-project reconciliation begins.
  useEffect(() => {
    if (workspaceId == null) return;
    const activationId = crypto.randomUUID();
    const clientId = (() => {
      const key = 'mcp-project-lifecycle-client-id';
      try {
        const existing = window.sessionStorage.getItem(key);
        if (existing) return existing;
        const created = crypto.randomUUID();
        window.sessionStorage.setItem(key, created);
        return created;
      } catch {
        return crypto.randomUUID();
      }
    })();
    let activation: Promise<unknown> | null = null;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        activation = apiCall('projects.activate', { id: workspaceId, activationId, clientId }).catch(() => undefined);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      // Always release: Monaco/LSP can mount before the deferred index
      // activation. If activation started, serialize deactivation after it so
      // HTTP and IPC cannot leave a late activation record behind.
      void (activation ?? Promise.resolve())
        .then(() => apiCall('projects.deactivate', { id: workspaceId, activationId, clientId }))
        .catch(() => undefined);
    };
  }, [workspaceId]);

  useEffect(() => {
    markRouteEvent('ProjectView:mounted', { projectId, tab: layout.primarySurface });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    setRouteTab(layout.primarySurface, projectId);
  }, [projectId, layout.primarySurface]);
  useLayoutEffect(() => {
    useActiveSurface.getState().setProjectTab({
      projectId,
      tab: layout.primarySurface,
      workspaceId,
      worktreePath: worktreeSelection.path,
    });
  }, [projectId, layout.primarySurface, workspaceId, worktreeSelection.path]);

  // Clear the active-surface signal when leaving the project view so off-project
  // pages don't read a stale rail tab.
  useLayoutEffect(() => () => useActiveSurface.getState().setProjectTab(null), []);

  // A session deep link intentionally takes over the primary area; ordinary
  // project opens retain the IDE-first Editor + left/right tool windows.
  useEffect(() => {
    if (initialSessionId) {
      layout.setPrimarySurface('sessions');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId, projectId]);

  // Deep link to a specific tab via `?tab=<id>` — used by the global
  // running-tasks dropdown to jump straight to this project's Runners
  // surface. Bottom-panel tools (runners/terminal/...) open the drawer at
  // that tab; everything else selects a side-rail tab. Only honour ids we
  // actually know about. `getState()` avoids re-running on every layout change.
  const appliedTabLink = useRef<string | null>(null);
  useEffect(() => {
    const link = `${projectId}:${location.key}`;
    if (appliedTabLink.current === link) return;
    const requested = new URLSearchParams(location.search).get('tab');
    if (!requested) return;
    // Legacy deep-links (?tab=runs|indexed|...) now resolve to the unified
    // Index tab — the global running-tasks dropdown jumps to ?tab=runs.
    const INDEX_ALIASES = new Set(['runs', 'indexed', 'dependencies']);
    const surface = projectSurface(requested);
    const pluginWindow = contribWindows.find((window) => window.id === requested);
    if (requested === 'chat') {
      // Backward compatibility: the former full Chat rail tab is now the
      // explicit rich Sessions primary surface. Alt+2 owns the compact rail.
      useWorkspaceLayout.getState().setPrimarySurface('sessions');
    } else if (requested === 'api-navigation') {
      useWorkspaceLayout.getState().setPrimarySurface('api');
    } else if (BOTTOM_BUILTIN_TAB_IDS.has(requested)) {
      useWorkspaceLayout.getState().setActiveBottom(requested);
    } else if (INDEX_ALIASES.has(requested)) {
      useWorkspaceLayout.getState().setPrimarySurface('index');
    } else if (surface?.kind === 'left') {
      useWorkspaceLayout.getState().setActiveLeft(requested);
      useWorkspaceLayout.getState().setPrimarySurface('editor');
    } else if (surface?.kind === 'right') {
      useWorkspaceLayout.getState().setPrimarySurface('editor');
      useWorkspaceLayout.getState().setActiveRight(requested);
    } else if (surface?.kind === 'primary') {
      useWorkspaceLayout.getState().setPrimarySurface(requested);
    } else if (pluginWindow?.side === 'left') {
      useWorkspaceLayout.getState().setPrimarySurface('editor');
      useWorkspaceLayout.getState().setActiveLeft(requested);
    } else if (pluginWindow?.side === 'right') {
      useWorkspaceLayout.getState().setPrimarySurface('editor');
      useWorkspaceLayout.getState().setActiveRight(requested);
    } else if (pluginWindow?.side === 'bottom') {
      useWorkspaceLayout.getState().setActiveBottom(requested);
    } else {
      return;
    }
    appliedTabLink.current = link;
  }, [projectId, location.key, location.search, contribWindows]);

  // ─── Open file from the tree → uses the same workspace store as the
  //     legacy Workspace component so tabs persist + the editor sees
  //     them ───
  const handleOpen = useCallback(
    (path: string) => {
      if (workspaceId == null || useWorkspaceStore.getState().activeProjectId !== workspaceId) return;
      // Instant open — content: null; MonacoMount fetches on activation
      // (SWR via ifModifiedSince once loaded). No await, no flicker.
      openFile({ projectId: workspaceId, path, content: null, dirty: false, lastModified: null });
      useWorkspaceLayout.getState().setPrimarySurface('editor');
    },
    [workspaceId, openFile],
  );

  // Cross-pane "show me the editor" requests (selection chip's open-in-
  // editor). The opener already put the tab in the workspace store; we
  // only need to surface the files tab.
  useEffect(() => {
    function onOpenFilesTab(e: Event) {
      const d = (e as CustomEvent).detail as { projectId?: number } | undefined;
      if (workspaceId != null && d?.projectId === workspaceId) useWorkspaceLayout.getState().setPrimarySurface('editor');
    }
    window.addEventListener('mcp:open-files-tab', onOpenFilesTab as EventListener);
    return () => window.removeEventListener('mcp:open-files-tab', onOpenFilesTab as EventListener);
  }, [workspaceId]);

  useLayoutEffect(() => {
    useWorkspaceLayout.getState().activateProject(projectId);
    return () => useWorkspaceLayout.getState().deactivateProject(projectId);
  }, [projectId]);

  useLayoutEffect(() => {
    if (workspaceId == null || useWorkspaceStore.getState().activeProjectId === workspaceId) return;
    flushWorkspaceDrafts();
    setProject(workspaceId, true);
  }, [workspaceId, setProject]);

  // Title-bar switcher feeds: report this window's active project to the main
  // process (so every window's switcher lists it under "Open Projects") and
  // record it in the recent-projects MRU. Electron call is optional-chained —
  // a plain-browser session just keeps the MRU.
  useEffect(() => {
    window.electronAPI?.windowRegistry?.setActiveProject?.(projectId);
    pushRecentProject(projectId);
  }, [projectId]);

  // Persiste mudanças estruturais das abas enquanto este projeto está ativo.
  // savePersistedTabs se auto-filtra por projectId, então uma aba estranha
  // jamais é escrita sob esta chave.
  useEffect(() => {
    if (workspaceId == null) return;
    const tabIdentity = (state: ReturnType<typeof useWorkspaceStore.getState>): string =>
      state.openFiles
        .filter((file) => file.projectId === workspaceId && (!file.kind || file.kind === 'file'))
        .map((file) => file.path)
        .join('\u0000');
    const initial = useWorkspaceStore.getState();
    let previousTabs = tabIdentity(initial);
    let previousActivePath = initial.activeFilePath;
    let previousPanes = initial.panes;
    let previousSplit = initial.splitDir;
    let previousActivePane = initial.activePaneId;
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (state.activeProjectId !== workspaceId) return;
      const nextTabs = tabIdentity(state);
      // Buffer content/dirty metadata changes on every key, but persisted tabs
      // contain only identity/layout. Avoid a synchronous localStorage write in
      // the typing hot path; persist only structural navigation changes.
      if (nextTabs === previousTabs
        && state.activeFilePath === previousActivePath
        && state.panes === previousPanes
        && state.splitDir === previousSplit
        && state.activePaneId === previousActivePane) return;
      previousTabs = nextTabs;
      previousActivePath = state.activeFilePath;
      previousPanes = state.panes;
      previousSplit = state.splitDir;
      previousActivePane = state.activePaneId;
      savePersistedTabs(
        workspaceId,
        state.openFiles,
        state.activeFilePath,
        state.panes,
        state.splitDir,
        state.activePaneId,
      );
    });
    return () => unsubscribe();
  }, [workspaceId]);

  // ─── Keymap: command registry + ONE capture-phase dispatcher ───
  // Replaces the old hardcoded Ctrl+J/W/B listener. Bindings come from the
  // active preset (IntelliJ by default) + user overrides; the Keymap dialog
  // (Ctrl+Alt+S) edits them live.
  useLayoutEffect(() => {
    if (workspaceId == null) return;
    startRecentFilesTracking();
    const unregister = registerProjectCommands({
      projectId: workspaceId,
      // Ctrl+J = toggle the bottom drawer; opens at Terminal when closed,
      // closes regardless of which bottom tab is active. getState() reads
      // live (this closure is registered once per project).
      toggleBottomTerminal: () => {
        const l = useWorkspaceLayout.getState();
        l.setActiveBottom(l.activeBottom ? null : 'terminal');
      },
      toggleProjectFiles: () => {
        const state = useWorkspaceLayout.getState();
        if (state.primarySurface !== 'editor' || state.activeLeft !== 'files') {
          state.setPrimarySurface('editor');
          state.setActiveLeft('files');
          return;
        }
        state.toggleLeft('files');
      },
      toggleChat: () => {
        const state = useWorkspaceLayout.getState();
        if (state.primarySurface !== 'editor' || state.activeRight !== 'chat') {
          state.setPrimarySurface('editor');
          state.setActiveRight('chat');
          return;
        }
        state.toggleRight('chat');
      },
    });
    const unregisterEditor = registerEditorCommands();
    return () => {
      unregisterEditor();
      unregister();
    };
    // layout.toggleBottom identity is stable in the store; setTab is a
    // useState setter. Registering once per project keeps closures fresh
    // enough (they read live state via getState()).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Plugin UI contributions — hydrate scoped to THIS project so activation
  // rules (auto-detection) are evaluated against its root: a plugin's panel
  // surfaces only when the project matches (e.g. Cloudflare only in a wrangler
  // repo). Re-runs when the project changes. Each contributed tool window
  // becomes an extra rail tab / bottom-panel tab rendering its sandboxed webview.
  useEffect(() => {
    if (workspaceId != null) void hydrateContributions(workspaceId);
  }, [workspaceId]);

  useLayoutEffect(() => {
    if (workspaceId == null) return;
    const activeLanguageId = activeFilePath ? languageIdForPath(activeFilePath) : undefined;
    const activeActions = contribEditorActions.filter((action) => (
      !action.documentSelector
      || (activeFilePath != null && matchesEditorDocument(action, activeFilePath, activeLanguageId))
    ));
    if (!activeActions.length) return undefined;
    return registerCommands(
      activeActions.map((action) => ({
        id: `plugin.${action.pluginNs}.${action.id}`,
        title: action.label,
        titlePt: action.label,
        category: action.category ?? `Plugin: ${action.pluginNs}`,
        target: action.scope === 'editor' ? 'editor' as const : 'project' as const,
        defaultKeys: action.shortcut ? { intellij: [action.shortcut], vscode: [action.shortcut] } : undefined,
        allowInInputs: true,
        run: async () => { await runPluginEditorAction(
          action,
          workspaceId,
          pluginEditorContextFromEditor(getActiveEditor(), workspaceId, activeFilePath ?? undefined, activeLanguageId),
        ); },
      })),
    );
  }, [activeFilePath, contribEditorActions, workspaceId]);
  return (
    // `h-full` (not `flex-1`) because the parent <main> in AppShell is
    // a plain block element — `flex-1` would no-op and the bottom of
    // the viewport would leak through as an empty background slab.
    // h-full inherits main's height (which AppShell sets via its own
    // flex-1 inside the 100dvh column).
    <div className="h-full min-h-0">
      <ProjectWorkbench
        projectId={projectId}
        projectName={projectName}
        mainRoot={project?.root_path ?? null}
        projectRoot={worktreeSelection.path ? workspaceRoot : project?.root_path ?? null}
        workspaceId={workspaceId}
        workspaceError={workspaceError}
        worktreeSelection={worktreeSelection}
        initialSessionId={initialSessionId}
        activeFilePath={activeFilePath}
        onOpenFile={handleOpen}
        contribWindows={contribWindows}
        builderJson={builderJson}
        previewEnabled={previewEnabled}
        framework={project?.framework}
      />
      {/* Keymap-driven overlays — open via Shift Shift / Ctrl+F12 / Ctrl+Alt+S. */}
      {workspaceId != null && (
        <div key={workspaceId} className="contents">
          <SearchEverywhere projectId={workspaceId} onOpenFile={handleOpen} />
          <FileStructurePopup projectId={workspaceId} />
          <LocalHistoryDialog />
        </div>
      )}
      <KeymapDialog />
    </div>
  );
}
