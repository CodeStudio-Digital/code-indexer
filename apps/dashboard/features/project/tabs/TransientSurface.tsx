/**
 * Abas transitórias do ProjectView (W4 decompose): tudo que NÃO é keep-alive
 * (chat/files/git). São conditional-render (montam ao entrar, desmontam ao sair) e
 * as pesadas (charts/diff/drawio/http/xterm) são chunks LAZY — fora do chunk inicial.
 */
import { Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { ProjectTabId } from '../tabs-config.js';
import { WebviewWindow } from '../../workspace/jetbrains/tool-windows/WebviewWindow.js';
import { ProjectPreview } from '../builder/ProjectPreview.js';
import { UserMemoryPanel } from '../../user-memory/UserMemoryPanel.js';

// Abas pesadas → chunks LAZY (W2/P3): só baixam quando a aba é clicada.
const SnapshotEditor = lazy(() => import('../../snapshots/index.js'));
// Index — aba unificada (Indexed/Runs/Dependencies/Architecture/Diff/Costs).
const IndexWorkspace = lazy(() => import('./index-workspace/IndexWorkspace.js').then((m) => ({ default: m.IndexWorkspace })));
const ApiClientTab = lazy(() => import('../../api-client/ApiClientTab.js').then((m) => ({ default: m.ApiClientTab })));
const DiagramsView = lazy(() => import('../diagrams/DiagramsView.js').then((m) => ({ default: m.DiagramsView })));

/** Fallback dos chunks lazy de aba. */
function TabSpinner() {
  return (
    <div className="h-full grid place-items-center text-xs text-muted-foreground gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  );
}

export interface TransientSurfaceProps {
  tab: ProjectTabId;
  projectId: number;
  projectName: string;
  contribWindows: ContribToolWindow[];
  builderJson: { stack: string; port: number } | null;
}

export function TransientSurface({ tab, projectId, projectName, contribWindows, builderJson }: TransientSurfaceProps) {
  // Snapshots owns its own master/detail layout (full height, inner scroll).
  // key={projectId} → remount per project (matches ProjectPreview/DiagramsView)
  // so an open create/edit SnapshotForm can't carry the previous project's
  // editTarget into the new project's context.
  if (tab === 'snapshots') {
    return <Suspense fallback={<TabSpinner />}><SnapshotEditor key={projectId} projectId={projectId} /></Suspense>;
  }

  // API client owns a full-height 3-pane layout.
  if (tab === 'api') {
    return <Suspense fallback={<TabSpinner />}><ApiClientTab projectId={projectId} /></Suspense>;
  }

  // Preview tab — the live dev-server preview, full-width.
  if (tab === 'preview') {
    return (
      <ProjectPreview
        key={projectId}
        projectId={projectId}
        pinnedPort={builderJson?.port}
        selectionEnabled={!!builderJson}
      />
    );
  }

  // Diagrams tab — full-area draw.io workspace.
  if (tab === 'diagrams') {
    return (
      <Suspense fallback={<TabSpinner />}>
        <DiagramsView key={projectId} projectId={projectId} />
      </Suspense>
    );
  }

  // Plugin-contributed tool window → its sandboxed webview fills the area.
  const pluginWin = contribWindows.find((w) => w.id === tab);
  if (pluginWin) {
    return (
      <div className="h-full overflow-hidden">
        <WebviewWindow
          namespace={pluginWin.pluginNs}
          title={pluginWin.title}
          entry={pluginWin.entry}
          projectId={projectId}
        />
      </div>
    );
  }

  // Search + analytics-style tabs → uniform padded scrollable surface.
  return (
    <div className="h-full overflow-auto">
      <Suspense fallback={<TabSpinner />}>
        <ToolSurface tab={tab} projectId={projectId} projectName={projectName} />
      </Suspense>
    </div>
  );
}

function ToolSurface({ tab, projectId, projectName }: { tab: ProjectTabId; projectId: number; projectName: string }) {
  switch (tab) {
    case 'index':
      // Owns its own full-height layout (header strip + sub-tabs + inner scroll).
      // Search migrou para dentro do Index (busca é uso do índice).
      return <IndexWorkspace projectId={projectId} projectName={projectName} />;
    case 'memory':
      return <div className="px-4 py-3"><UserMemoryPanel /></div>;
    default:
      return null;
  }
}
