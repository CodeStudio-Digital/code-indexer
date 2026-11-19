/**
 * Superfícies lazy do ProjectView (W4 decompose): abas realmente transitórias
 * seguem conditional-render (montam ao entrar, desmontam ao sair) no workbench.
 * As pesadas
 * (charts/diff/drawio/http/xterm) seguem em chunks LAZY — fora do chunk inicial.
 */
import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react';
import { Loader2 } from 'lucide-react';
import { ErrorBoundary } from '../../../components/ErrorBoundary.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { ProjectTabId } from '../tabs-config.js';
import { WebviewWindow } from '../../workspace/jetbrains/tool-windows/WebviewWindow.js';
import { ProjectPreview } from '../builder/ProjectPreview.js';
import type { PreviewFramework } from '../builder/useSelectorMode.js';
import { UserMemoryPanel } from '../../user-memory/UserMemoryPanel.js';
import type { ApiClientWorkbenchSlots } from '../../api-client/workbench-slots.js';

// Abas pesadas → chunks LAZY (W2/P3): só baixam quando a aba é clicada.
const SnapshotEditor = lazy(() => import('../../snapshots/index.js'));
// Index — visão operacional do índice estrutural e semântico, arquivos e dependências.
const IndexWorkspace = lazy(() => import('./index-workspace/IndexWorkspace.js').then((m) => ({ default: m.IndexWorkspace })));
const ApiClientTab = lazy(() => import('../../api-client/ApiClientTab.js').then((m) => ({ default: m.ApiClientTab })));
const DbClientTab = lazy(() => import('../../db-client/DbClientTab.js').then((m) => ({ default: m.DbClientTab })));
const DiagramsView = lazy(() => import('../diagrams/DiagramsView.js').then((m) => ({ default: m.DiagramsView })));

type SshPanelProps = { projectId: number; workspaceId?: number | null };
type SshPanelComponent = ComponentType<SshPanelProps>;

const loadSshPanel = (): Promise<SshPanelComponent> =>
  import('../../ssh/SshPanel.js').then((module) => module.SshPanel);

const SSH_PANEL_LOAD_TIMEOUT_MS = 30_000;

/**
 * Load SSH outside React.lazy/Suspense. A component-local lazy type can leave a
 * retained surface suspended after Fast Refresh even though Vite has already
 * resolved the module. Explicit state makes completion observable and lets the
 * error boundary remount/retry a failed or genuinely stalled chunk.
 */
function AsyncSshPanel(props: SshPanelProps) {
  const [Panel, setPanel] = useState<SshPanelComponent | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    const timeout = globalThis.setTimeout(() => {
      if (active) setLoadError(new Error('SSH panel loading timed out.'));
    }, SSH_PANEL_LOAD_TIMEOUT_MS);

    void loadSshPanel().then(
      (LoadedPanel) => {
        if (!active) return;
        globalThis.clearTimeout(timeout);
        // Components are functions; wrap the value so React does not treat it
        // as a functional state updater.
        setPanel(() => LoadedPanel);
      },
      (error: unknown) => {
        if (!active) return;
        globalThis.clearTimeout(timeout);
        setLoadError(error instanceof Error ? error : new Error(String(error)));
      },
    );

    return () => {
      active = false;
      globalThis.clearTimeout(timeout);
    };
  }, []);

  if (loadError) throw loadError;
  return Panel ? <Panel {...props} /> : <TabSpinner />;
}

/** Fallback dos chunks lazy de aba. */
function TabSpinner() {
  return (
    <div className="h-full grid place-items-center text-xs text-muted-foreground gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  );
}

interface TransientSurfaceProps {
  tab: ProjectTabId;
  projectId: number;
  workspaceId?: number | null;
  worktreePath?: string | null;
  projectName: string;
  onOpenFile: (path: string) => void;
  contribWindows: ContribToolWindow[];
  builderJson: { stack: string; port: number } | null;
  framework?: PreviewFramework;
  apiWorkbenchSlots?: ApiClientWorkbenchSlots;
}

export function TransientSurface({ tab, projectId, workspaceId = projectId, worktreePath, projectName, onOpenFile, contribWindows, builderJson, framework, apiWorkbenchSlots }: TransientSurfaceProps) {
  // Snapshots owns its own master/detail layout (full height, inner scroll).
  // key={projectId} → remount per project (matches ProjectPreview/DiagramsView)
  // so an open create/edit SnapshotForm can't carry the previous project's
  // editTarget into the new project's context.
  if (tab === 'snapshots') {
    return <Suspense fallback={<TabSpinner />}><SnapshotEditor key={projectId} projectId={projectId} /></Suspense>;
  }

  // API client owns a full-height 3-pane layout. `docsAccess` adds the in-tab
  // Client / Docs toggle (the Docs Studio lives here, not as its own rail tab).
  if (tab === 'api') {
    return <Suspense fallback={<TabSpinner />}><ApiClientTab projectId={projectId} docsAccess workbenchSlots={apiWorkbenchSlots} /></Suspense>;
  }

  // Database client — DataGrip × phpMyAdmin. key={projectId} → remount per
  // project so a live connection session never bleeds across projects.
  if (tab === 'databases') {
    return <Suspense fallback={<TabSpinner />}><DbClientTab key={projectId} /></Suspense>;
  }

  if (tab === 'ssh') {
    // The primary workbench keeps this surface mounted while navigating so
    // shells, SFTP directories and in-flight transfers survive tab switches.
    // The key still hard-isolates that live state when the project changes.
    return (
      <ErrorBoundary label="SSH" resetKey={projectId}>
        <AsyncSshPanel key={projectId} projectId={projectId} workspaceId={workspaceId} />
      </ErrorBoundary>
    );
  }

  // Preview tab — the live dev-server preview, full-width.
  if (tab === 'preview') {
    return workspaceId != null && (
      <ProjectPreview
        key={workspaceId}
        projectId={workspaceId}
        runnerProjectId={projectId}
        worktreePath={worktreePath}
        pinnedPort={worktreePath ? undefined : builderJson?.port}
        selectionEnabled={!!builderJson}
        framework={framework}
      />
    );
  }

  // Diagrams tab — full-area draw.io workspace.
  if (tab === 'diagrams') {
    return workspaceId != null && (
      <Suspense fallback={<TabSpinner />}>
        <DiagramsView key={workspaceId} projectId={workspaceId} />
      </Suspense>
    );
  }

  // Plugin-contributed tool window → its sandboxed webview fills the area.
  const pluginWin = contribWindows.find((w) => w.id === tab);
  if (pluginWin && workspaceId != null) {
    return (
      <div className="h-full overflow-hidden">
        <WebviewWindow
          namespace={pluginWin.pluginNs}
          title={pluginWin.title}
          entry={pluginWin.entry}
          key={workspaceId}
          projectId={workspaceId}
        />
      </div>
    );
  }

  // Search + analytics-style tabs → uniform padded scrollable surface.
  return workspaceId != null && (
    <div className="h-full overflow-auto">
      <Suspense fallback={<TabSpinner />}>
        <ToolSurface key={workspaceId} tab={tab} projectId={workspaceId} projectName={projectName} onOpenFile={onOpenFile} />
      </Suspense>
    </div>
  );
}

function ToolSurface({ tab, projectId, projectName, onOpenFile }: {
  tab: ProjectTabId;
  projectId: number;
  projectName: string;
  onOpenFile: (path: string) => void;
}) {
  switch (tab) {
    case 'index':
      // Owns its own full-height layout (header strip + sub-tabs + inner scroll).
      return <IndexWorkspace projectId={projectId} projectName={projectName} onOpenFile={onOpenFile} />;
    case 'memory':
      return <div className="px-4 py-3"><UserMemoryPanel /></div>;
    default:
      return null;
  }
}
