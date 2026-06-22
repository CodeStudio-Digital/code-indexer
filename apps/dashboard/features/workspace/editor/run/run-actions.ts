/**
 * Editor action: "Run File" (Shift+F10, IntelliJ's Run shortcut). Runs the
 * active file with its runtime (php/python/node) if the extension is
 * supported, else no-ops. Registered once per Monaco mount; reads the active
 * file from the workspace store at run time (the editor is reused across
 * file switches). No contextMenuGroupId — keybinding + command palette only,
 * so the right-click menu stays uncluttered.
 */

import type * as MonacoNs from 'monaco-editor';
import { useWorkspaceStore } from '../../../../state/workspace.js';
import { fileRunCommand, runnableForFile } from '../../../../lib/run-target.js';
import { launchRun } from '../../../../state/run-launch.js';

function activeFilePath(): { projectId: number; path: string } | null {
  const ws = useWorkspaceStore.getState();
  const path = ws.activeFilePath;
  if (!path) return null;
  const open = ws.openFiles.find((f) => f.path === path && f.projectId === ws.activeProjectId);
  if (!open || (open.kind && open.kind !== 'file')) return null;
  return { projectId: open.projectId, path };
}

export function registerRunActions(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNs,
): void {
  editor.addAction({
    id: 'mcp.runFile',
    // Editor-internal label (command palette) — not scanned JSX.
    label: 'Run File',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F10],
    run: () => {
      const file = activeFilePath();
      if (!file) return;
      const target = runnableForFile(file.path);
      if (!target) return;
      const base = file.path.split('/').pop() ?? file.path;
      void launchRun({
        projectId: file.projectId,
        command: fileRunCommand(file.path, target.runtime),
        label: `Run ${base}`,
        manager: target.manager,
      });
    },
  });
}
