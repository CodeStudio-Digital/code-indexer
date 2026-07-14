import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import type { ContribToolWindow } from '../../state/contribution-registry.js';
import { EditorPaneHost } from '../workspace/EditorPane.js';
import type { PreviewFramework } from './builder/useSelectorMode.js';
import { ChatSurface } from './tabs/ChatSurface.js';
import type { AgentChatWorkbenchSlots } from '../chat/types.js';
import type { ApiClientWorkbenchSlots } from '../api-client/workbench-slots.js';
import { TransientSurface } from './tabs/TransientSurface.js';

interface ProjectPrimarySurfaceProps {
  surface: string;
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  contribWindows: ContribToolWindow[];
  builderJson: { stack: string; port: number } | null;
  previewEnabled: boolean;
  framework?: PreviewFramework;
  sessionsRequested: boolean;
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
      className={cn('absolute inset-0', !active && 'invisible pointer-events-none')}
    >
      {children}
    </div>
  );
}

/** Keeps stateful Editor, Sessions and SSH surfaces mounted while navigating. */
export function ProjectPrimarySurface(props: ProjectPrimarySurfaceProps) {
  const [sessionsSeen, setSessionsSeen] = useState(props.surface === 'sessions');
  const [apiSeen, setApiSeen] = useState(props.surface === 'api');
  const [sshSeen, setSshSeen] = useState(props.surface === 'ssh');

  useEffect(() => {
    if (props.surface === 'sessions' || props.sessionsRequested) setSessionsSeen(true);
  }, [props.sessionsRequested, props.surface]);
  useEffect(() => {
    if (props.surface === 'api') setApiSeen(true);
  }, [props.surface]);
  useEffect(() => {
    if (props.surface === 'ssh') setSshSeen(true);
  }, [props.surface]);

  const renderSsh = sshSeen || props.surface === 'ssh';
  const transient = !['editor', 'sessions', 'api', 'ssh'].includes(props.surface);
  return (
    <div className="relative h-full min-h-0 bg-[var(--workbench-surface)]">
      <RetainedPane active={props.surface === 'editor'} surface="editor">
        <EditorPaneHost />
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
            contribWindows={props.contribWindows}
            builderJson={props.builderJson}
            framework={props.framework}
          />
        </div>
      )}
    </div>
  );
}
