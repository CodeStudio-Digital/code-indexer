/**
 * Editor + Copilot rail layout used by ProjectView's Files and Git tabs.
 * Wraps the shared `EditorPane` with an optional right-docked chat rail,
 * gated on the shared workspace layout (`activeRight === 'chat'`). When the
 * rail is closed a slim affordance on the right edge re-opens it — same
 * idiom ProjectView already uses for the builder preview toggle.
 *
 * Isolated here so ProjectView/EditorPane don't grow the three-panel logic,
 * and so Files and Git reuse the exact same behavior.
 */
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { EditorPane } from '../workspace/EditorPane.js';
import { EditorChatRail } from './editor-chat/EditorChatRail.js';

interface Props {
  projectId: number;
  projectName: string;
}

export function EditorChatLayout({ projectId, projectName }: Props) {
  const { t } = useTranslation('workspace');
  const activeRight = useWorkspaceLayout((s) => s.activeRight);
  const setActiveRight = useWorkspaceLayout((s) => s.setActiveRight);
  const chatOpen = activeRight === 'chat';

  return (
    <div className="flex h-full min-h-0">
      <PanelGroup direction="horizontal" autoSaveId="mcp-project-editor-chat" className="flex-1 min-w-0">
        <Panel id="editor" order={1} minSize={30}>
          <EditorPane />
        </Panel>
        {chatOpen && (
          <>
            <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
            <Panel id="editor-chat" order={2} defaultSize={32} minSize={20} maxSize={50} className="min-w-0">
              <EditorChatRail
                projectId={projectId}
                projectName={projectName}
                onClose={() => setActiveRight(null)}
              />
            </Panel>
          </>
        )}
      </PanelGroup>
      {!chatOpen && (
        <button
          type="button"
          onClick={() => setActiveRight('chat')}
          title={t('editorChat.openPanel')}
          className="w-6 shrink-0 border-l flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
