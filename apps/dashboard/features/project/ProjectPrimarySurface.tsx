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
 * Keep inactive primary surfaces mounted without letting a child override the
 * concealment. `visibility` is inherited, so DatabaseEditorStack's active-tab
 * `visible` class could make a retained SQL editor paint over ChatSurface.
 * Opacity applies to the composed parent layer instead and keeps dimensions
 * available for Monaco and virtualized grids.
 */
export function retainedPaneClassName(active: boolean): string {
  return cn(
    'absolute inset-0',
    active ? 'z-10 opacity-100' : 'z-0 opacity-0 pointer-events-none',
  );
}

/** Keeps stateful Editor, Sessions and SSH surfaces mounted while navigating. */
export function ProjectPrimarySurface(props: ProjectPrimarySurfaceProps) {
  const [sessionsSeen, setSessionsSeen] = useState(props.surface === 'sessions');
  const [apiSeen, setApiSeen] = useState(props.surface === 'api');
  const [sshSeen, setSshSeen] = useState(props.surface === 'ssh');

  useEffect(() => {
    if (props.surface === 'sessions') setSessionsSeen(true);
  }, [props.surface]);
  useEffect(() => {
    if (props.surface === 'api') setApiSeen(true);
  }, [props.surface]);
  useEffect(() => {
    if (props.surface === 'ssh') setSshSeen(true);
  }, [props.surface]);
  useEffect(() => {
    if (props.surface === 'editor') reapplySharedMonacoTheme();
  }, [props.surface]);

  const renderSsh = sshSeen || props.surface === 'ssh';
  const transient = !['editor', 'sessions', 'api', 'ssh'].includes(props.surface);
  return (
    <div className="relative h-full min-h-0 bg-[var(--workbench-surface)]">
      <RetainedPane active={props.surface === 'editor'} surface="editor">
        <EditorPaneHost />
        <Suspense fallback={null}>
          <ProjectLspInstallPrompts projectId={props.projectId} />
        </Suspense>
      </RetainedPane>
      {sessionsSeen && (
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
      {renderSsh && (
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
      {apiSeen && (
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
