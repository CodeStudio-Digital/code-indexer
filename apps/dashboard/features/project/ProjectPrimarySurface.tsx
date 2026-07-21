import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import type { ContribToolWindow } from '../../state/contribution-registry.js';
import { EditorPaneHost } from '../workspace/EditorPane.js';
import type { PreviewFramework } from './builder/useSelectorMode.js';
import { ChatSurface } from './tabs/ChatSurface.js';
import type { AgentChatWorkbenchSlots } from '../chat/types.js';
import type { ApiClientWorkbenchSlots } from '../api-client/workbench-slots.js';
import { TransientSurface } from './tabs/TransientSurface.js';
import { reapplySharedMonacoTheme } from '../../lib/monaco-theme.js';

const ProjectLspInstallPrompts = lazy(() =>
  import('../workspace/editor/LspInstallPrompt.js').then((module) => ({ default: module.ProjectLspInstallPrompts })),
);

interface ProjectPrimarySurfaceProps {
  surface: string;
  projectId: number;
  projectName: string;
  onOpenFile: (path: string) => void;
  initialSessionId?: number;
  contribWindows: ContribToolWindow[];
  builderJson: { stack: string; port: number } | null;
  previewEnabled: boolean;
  framework?: PreviewFramework;
  sessionWorkbenchSlots: AgentChatWorkbenchSlots;
  apiWorkbenchSlots: ApiClientWorkbenchSlots;
}

type StatefulPrimarySurface = 'editor' | 'sessions' | 'api' | 'ssh';

const STATEFUL_PRIMARY_SURFACES = new Set<StatefulPrimarySurface>(['editor', 'sessions', 'api', 'ssh']);
/** Active surface plus one recently used warm surface. */
export const PRIMARY_SURFACE_BUDGET = 2;

function isStatefulPrimarySurface(surface: string): surface is StatefulPrimarySurface {
  return STATEFUL_PRIMARY_SURFACES.has(surface as StatefulPrimarySurface);
}

/**
 * MRU budget for expensive primary trees. The active surface is always kept;
 * one previous surface stays warm. A transient active surface consumes one of
 * the two renderer slots, so only the most recent stateful surface is retained.
 */
export function retainedPrimarySurfaces(
  previous: readonly StatefulPrimarySurface[],
  activeSurface: string,
  budget = PRIMARY_SURFACE_BUDGET,
): StatefulPrimarySurface[] {
  const active = isStatefulPrimarySurface(activeSurface) ? activeSurface : null;
  const limit = active ? Math.max(1, budget) : Math.max(0, budget - 1);
  if (limit === 0) return [];
  const candidates: StatefulPrimarySurface[] = active ? [active, ...previous] : [...previous];
  const unique: StatefulPrimarySurface[] = [];
  for (const surface of candidates) {
    if (!STATEFUL_PRIMARY_SURFACES.has(surface) || unique.includes(surface)) continue;
    unique.push(surface);
    if (unique.length === limit) break;
  }
  return unique;
}

function RetainedPane({
  active,
  surface,
  children,
}: {
  active: boolean;
  surface: 'editor' | 'sessions' | 'api' | 'ssh';
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden={!active}
      data-project-primary-surface={surface}
      className={retainedPaneClassName(active)}
    >
      {children}
    </div>
  );
}

/**
 * Keep the one warm primary surface isolated from the active layer. Do not put
 * Monaco under React Activity: @monaco-editor/react disposes its imperative
 * editor when hidden effects are cleaned up, but its preserved mount state does
 * not recreate that editor when the Activity becomes visible again.
 */
export function retainedPaneClassName(active: boolean): string {
  return cn(
    'absolute inset-0',
    active ? 'z-10 opacity-100' : 'z-0 opacity-0 pointer-events-none',
  );
}

/** Keeps only the active and most-recent stateful surface mounted. */
export function ProjectPrimarySurface(props: ProjectPrimarySurfaceProps) {
  const [retention, setRetention] = useState<{
    projectId: number;
    surfaces: StatefulPrimarySurface[];
  }>(() => ({
    projectId: props.projectId,
    surfaces: retainedPrimarySurfaces([], props.surface),
  }));
  // A project switch invalidates the old MRU immediately, before the syncing
  // effect, so a heavy tree can never render one frame with another project.
  const previous = retention.projectId === props.projectId ? retention.surfaces : [];
  const mountedSurfaces = retainedPrimarySurfaces(previous, props.surface);

  useEffect(() => {
    setRetention((current) => {
      const currentProjectSurfaces = current.projectId === props.projectId ? current.surfaces : [];
      const next = retainedPrimarySurfaces(currentProjectSurfaces, props.surface);
      if (current.projectId === props.projectId
        && current.surfaces.length === next.length
        && current.surfaces.every((surface, index) => surface === next[index])) return current;
      return { projectId: props.projectId, surfaces: next };
    });
  }, [props.projectId, props.surface]);
  useEffect(() => {
    if (props.surface === 'editor') reapplySharedMonacoTheme();
  }, [props.surface]);

  const transient = !isStatefulPrimarySurface(props.surface);
  return (
    <div className="relative h-full min-h-0 bg-[var(--workbench-surface)]">
      {mountedSurfaces.includes('editor') && (
        <RetainedPane active={props.surface === 'editor'} surface="editor">
          <EditorPaneHost />
          <Suspense fallback={null}>
            <ProjectLspInstallPrompts projectId={props.projectId} />
          </Suspense>
        </RetainedPane>
      )}
      {mountedSurfaces.includes('sessions') && (
        <RetainedPane active={props.surface === 'sessions'} surface="sessions">
          <ChatSurface
            projectId={props.projectId}
            projectName={props.projectName}
            initialSessionId={props.initialSessionId}
            builderJson={props.builderJson}
            previewEnabled={props.previewEnabled}
            framework={props.framework}
            workbenchSlots={props.sessionWorkbenchSlots}
          />
        </RetainedPane>
      )}
      {mountedSurfaces.includes('ssh') && (
        <RetainedPane active={props.surface === 'ssh'} surface="ssh">
          <TransientSurface
            tab="ssh"
            projectId={props.projectId}
            projectName={props.projectName}
            onOpenFile={props.onOpenFile}
            contribWindows={props.contribWindows}
            builderJson={props.builderJson}
            framework={props.framework}
          />
        </RetainedPane>
      )}
      {mountedSurfaces.includes('api') && (
        <RetainedPane active={props.surface === 'api'} surface="api">
          <TransientSurface
            tab="api"
            projectId={props.projectId}
            projectName={props.projectName}
            onOpenFile={props.onOpenFile}
            contribWindows={props.contribWindows}
            builderJson={props.builderJson}
            framework={props.framework}
            apiWorkbenchSlots={props.apiWorkbenchSlots}
          />
        </RetainedPane>
      )}
      {transient && (
        <div className="absolute inset-0">
          <TransientSurface
            tab={props.surface}
            projectId={props.projectId}
            projectName={props.projectName}
            onOpenFile={props.onOpenFile}
            contribWindows={props.contribWindows}
            builderJson={props.builderJson}
            framework={props.framework}
          />
        </div>
      )}
    </div>
  );
}
