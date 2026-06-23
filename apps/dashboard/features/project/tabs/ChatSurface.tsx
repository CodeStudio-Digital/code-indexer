/**
 * Superfície de chat da aba `chat` (W4 decompose). Projetos builder (ou qualquer um
 * com dev server rodando) dividem em chat | preview ao vivo (estilo V0). A árvore é
 * ESTÁVEL através do toggle de preview — o Panel do chat é sempre o 1º filho do MESMO
 * PanelGroup, então alternar só adiciona/remove o Panel do preview; o AgentChat nunca
 * é desmontado (o que dropava a sessão aberta).
 */
import { useEffect } from 'react';
import { PanelRightOpen } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useWorkspaceLayout } from '../../../state/workspace-layout.js';
import { ProjectPreview } from '../builder/ProjectPreview.js';
import type { PreviewFramework } from '../builder/useSelectorMode.js';
import AgentChat from '../../chat/index.js';
import { markRouteEvent } from '../../../lib/perf/route-startup-metrics.js';

export interface ChatSurfaceProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  builderJson: { stack: string; port: number } | null;
  previewEnabled: boolean;
  framework?: PreviewFramework;
}

export function ChatSurface({ projectId, projectName, initialSessionId, builderJson, previewEnabled, framework }: ChatSurfaceProps) {
  const previewVisible = useWorkspaceLayout((s) => s.previewVisible);
  const togglePreview = useWorkspaceLayout((s) => s.togglePreview);
  useEffect(() => {
    markRouteEvent('ChatSurface:mounted', { projectId, tab: 'chat' });
  }, [projectId]);

  if (!previewEnabled) {
    return <AgentChat projectId={projectId} projectName={projectName} initialSessionId={initialSessionId} />;
  }

  const chat = (
    <AgentChat
      projectId={projectId}
      projectName={projectName}
      initialSessionId={initialSessionId}
      selectionPrefixSessionId={projectId}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      <PanelGroup direction="horizontal" autoSaveId="mcp-project-builder-horiz" className="flex-1 min-w-0">
        <Panel id="builder-chat" order={1} defaultSize={previewVisible ? 52 : 100} minSize={32}>
          {chat}
        </Panel>
        {previewVisible && (
          <>
            <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
            <Panel id="builder-preview" order={2} defaultSize={48} minSize={28}>
              {/* key: full remount on project switch — local preview state
                  (detected URL, problems, pop-out) must never leak from
                  another project's dev server. */}
              <ProjectPreview
                key={projectId}
                projectId={projectId}
                pinnedPort={builderJson?.port}
                selectionEnabled={!!builderJson}
                framework={framework}
                onHide={togglePreview}
              />
            </Panel>
          </>
        )}
      </PanelGroup>
      {!previewVisible && (
        <button
          onClick={togglePreview}
          title="Show preview"
          className="w-6 shrink-0 border-l flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
