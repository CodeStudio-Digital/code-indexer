/**
 * Chat tool window — wraps the existing AgentChat for the right rail.
 * AgentChat already owns its own session sidebar, header, composer, etc.,
 * so this is intentionally a thin shell. When the user wants to see the
 * raw sessions list separately they use the Sessions tool window.
 */

import AgentChat from '../../../chat/index.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';

interface ChatWindowProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  onClose?: () => void;
}

export function ChatWindow({ projectId, projectName, initialSessionId, onClose }: ChatWindowProps) {
  return (
    <ToolWindowFrame title="Agent chat" onClose={onClose}>
      <AgentChat
        projectId={projectId}
        projectName={projectName}
        initialSessionId={initialSessionId}
      />
    </ToolWindowFrame>
  );
}
