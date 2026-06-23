/**
 * Editor context-menu actions that stage code into the Copilot-style chat
 * rail (`EditorChatRail`). Registered once per Monaco mount; the editor
 * instance is reused across file switches (the model swaps, `onMount`
 * does NOT re-fire), so the actions read the CURRENT active file from the
 * workspace store at run time instead of closing over the mount-time file.
 *
 * They write into `editor-chat-context` (keyed by projectId) and pop the
 * chat rail open via the shared workspace layout (`activeRight = 'chat'`).
 */
import type * as MonacoNs from 'monaco-editor';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { useWorkspaceLayout } from '../../../state/workspace-layout.js';
import { editorChatContextActions } from '../../../state/editor-chat-context.js';
import { getActiveEditor } from './editor-models.js';

function openRail(): void {
  const layout = useWorkspaceLayout.getState();
  if (layout.activeRight !== 'chat') layout.setActiveRight('chat');
}

/** Resolve the file backing the active editor model (path + owning project). */
function activeFile(): { projectId: number; path: string } | null {
  const ws = useWorkspaceStore.getState();
  const path = ws.activeFilePath;
  if (!path) return null;
  const open = ws.openFiles.find((f) => f.path === path && f.projectId === ws.activeProjectId);
  if (!open || open.kind === 'git-log' || open.kind === 'git-stash' || open.kind === 'diff') return null;
  return { projectId: open.projectId, path };
}

export function registerChatActions(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNs,
): void {
  editor.addAction({
    id: 'mcp.addSelectionToChat',
    // Label is editor-internal (Monaco command palette / context menu),
    // not scanned JSX — kept literal. The rail UI itself is translated.
    label: 'Add Selection to Chat',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
    run: (ed) => {
      const file = activeFile();
      if (!file) return;
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (!sel || !model || sel.isEmpty()) {
        openRail();
        return;
      }
      const text = model.getValueInRange(sel);
      if (!text.trim()) {
        openRail();
        return;
      }
      editorChatContextActions().addSelection(file.projectId, {
        path: file.path,
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber,
        text,
      });
      openRail();
    },
  });

  editor.addAction({
    id: 'mcp.addFileToChat',
    label: 'Add File to Chat',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.6,
    run: () => {
      const file = activeFile();
      if (!file) return;
      editorChatContextActions().addFileRef(file.projectId, file.path);
      openRail();
    },
  });

  registerSelectionTracker(editor);
}

/**
 * Mirror the live editor selection into the chat context store so the rail
 * can show a Copilot-style "current selection" chip (file:Lx-y) and include
 * it on the next send. Debounced — selection events fire on every cursor
 * move. Cleared when the selection is empty or the model swaps (file switch).
 */
function registerSelectionTracker(editor: MonacoNs.editor.IStandaloneCodeEditor): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastProjectId: number | null = null;

  const push = (): void => {
    const file = activeFile();
    const sel = editor.getSelection();
    const model = editor.getModel();
    if (!file || !sel || !model || sel.isEmpty()) {
      if (file) editorChatContextActions().setLiveSelection(file.projectId, null);
      return;
    }
    lastProjectId = file.projectId;
    const text = model.getValueInRange(sel);
    if (!text.trim()) {
      editorChatContextActions().setLiveSelection(file.projectId, null);
      return;
    }
    editorChatContextActions().setLiveSelection(file.projectId, {
      path: file.path,
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
      text,
    });
  };

  const d1 = editor.onDidChangeCursorSelection(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(push, 250);
  });
  const d2 = editor.onDidChangeModel(() => {
    if (timer) clearTimeout(timer);
    push();
  });
  // Tear down when the editor is disposed (tab switched to a diff/markdown/
  // welcome view, or project remount): drop the listeners + pending debounce
  // and clear any lingering live chip so it never outlives its editor.
  editor.onDidDispose(() => {
    if (timer) clearTimeout(timer);
    d1.dispose();
    d2.dispose();
    if (lastProjectId != null) editorChatContextActions().setLiveSelection(lastProjectId, null);
  });
}

/**
 * Read the CURRENT selection straight from the active editor (NO debounce).
 * Used at send time so a selection made <250ms before Send still rides along
 * — the debounced live-selection store value may not have landed yet. Returns
 * null when there is no non-empty selection on a real file.
 */
export function readActiveSelection():
  | { projectId: number; path: string; startLine: number; endLine: number; text: string }
  | null {
  const editor = getActiveEditor();
  const file = activeFile();
  if (!editor || !file) return null;
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (!sel || !model || sel.isEmpty()) return null;
  const text = model.getValueInRange(sel);
  if (!text.trim()) return null;
  return {
    projectId: file.projectId,
    path: file.path,
    startLine: sel.startLineNumber,
    endLine: sel.endLineNumber,
    text,
  };
}
