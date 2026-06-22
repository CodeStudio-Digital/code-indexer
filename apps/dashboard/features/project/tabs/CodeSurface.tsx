/**
 * Superfície de código das abas Files/Git (W4 decompose + W2 keep-alive). Files e Git
 * compartilham UM ÚNICO editor (EditorChatLayout) — só o painel esquerdo troca
 * (FileTreeView ↔ GitWindow). Isso garante um só Monaco vivo entre as duas abas
 * (economia de memória + conserta o double-mount latente do design antigo, onde cada
 * aba renderizava seu próprio EditorChatLayout).
 */
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FileTreeView } from '../../workspace/file-tree/FileTreeView.js';
import { GitWindow } from '../../workspace/jetbrains/tool-windows/GitWindow.js';
import { EditorChatLayout } from '../EditorChatLayout.js';

export interface CodeSurfaceProps {
  /** Qual painel esquerdo mostrar — a aba ativa (ou a última, quando escondida). */
  mode: 'files' | 'git';
  /** False when the keep-alive pane is mounted but hidden behind another tab. */
  visible: boolean;
  projectId: number;
  projectName: string;
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
}

export function CodeSurface({ mode, visible, projectId, projectName, activeFilePath, onOpenFile }: CodeSurfaceProps) {
  // autoSaveId único (não por-modo) de propósito: a coluna do editor é a mesma
  // entre Files e Git, então a largura do painel esquerdo persiste através da troca
  // — comportamento mais previsível que dois tamanhos concorrentes.
  return (
    <PanelGroup direction="horizontal" autoSaveId="mcp-project-code-horiz">
      <Panel defaultSize={22} minSize={12} maxSize={50}>
        <div className="h-full border-r overflow-hidden">
          {mode === 'git' ? (
            <GitWindow projectId={projectId} active={visible && mode === 'git'} />
          ) : (
            <FileTreeView projectId={projectId} active={visible && mode === 'files'} activePath={activeFilePath} onOpen={onOpenFile} />
          )}
        </div>
      </Panel>
      <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
      <Panel minSize={30}>
        {/* UMA instância — montada uma vez, reusada entre Files e Git. */}
        <EditorChatLayout projectId={projectId} projectName={projectName} />
      </Panel>
    </PanelGroup>
  );
}
