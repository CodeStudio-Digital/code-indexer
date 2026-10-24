/**
 * Superfície de chat da aba `chat` (W4 decompose). O preview ao vivo entra no
 * rail direito da própria sessão; assim ele reutiliza o dock contextual do chat
 * em vez de criar um terceiro painel redimensionável ao lado dele.
 */
import { useEffect } from 'react';
import type { PreviewFramework } from '../builder/useSelectorMode.js';
import AgentChat from '../../chat/index.js';
import type { AgentChatWorkbenchSlots } from '../../chat/types.js';
import { markRouteEvent } from '../../../lib/perf/route-startup-metrics.js';

interface ChatSurfaceProps {
  projectId: number;
  projectName: string;
  initialSessionId?: string;
  builderJson: { stack: string; port: number } | null;
  previewEnabled: boolean;
  framework?: PreviewFramework;
  workbenchSlots?: AgentChatWorkbenchSlots;
}

export function ChatSurface({ projectId, projectName, initialSessionId, builderJson, previewEnabled, framework, workbenchSlots }: ChatSurfaceProps) {
  useEffect(() => {
    markRouteEvent('ChatSurface:mounted', { projectId, tab: 'chat' });
  }, [projectId]);

  return (
    <AgentChat
      projectId={projectId}
      projectName={projectName}
      initialSessionId={initialSessionId}
      selectionPrefixSessionId={previewEnabled ? projectId : undefined}
      preview={previewEnabled ? {
        pinnedPort: builderJson?.port,
        selectionEnabled: !!builderJson,
        framework,
      } : undefined}
      workbenchSlots={workbenchSlots}
    />
  );
}
