/**
 * Right pane of the Workspace — currently a thin wrapper around the
 * existing AgentChat. Kept as a separate file so the workspace shell
 * doesn't import AgentChat directly; if/when we add tabs to the right
 * pane (chat / multi-agent / inspector) the swap stays local.
 */

import AgentChat from '../chat/index.js';

interface RightPaneProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
}

export function RightPane({ projectId, projectName, initialSessionId }: RightPaneProps) {
  return (
    <div className="h-full flex flex-col bg-card/20 border-l min-h-0">
      <AgentChat
        projectId={projectId}
        projectName={projectName}
        initialSessionId={initialSessionId}
      />
    </div>
  );
}
