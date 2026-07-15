/**
 * Registry tying an open SFTP-edit tab (kind: 'sftp') to its live Monaco model
 * and a self-contained save closure. Mirrors the editor-models janitor, but for
 * remote-edit tabs: when the tab leaves `openFiles` (closed), we dispose its
 * model — that IS the "cleanup on close" (the content lived only in memory, so
 * there's no temp file to delete). The save closure is captured at mount time
 * over the MODEL (not the editor instance), so it survives tab switches: an
 * inactive remote tab still saves via Save-All.
 */
import type * as MonacoNs from 'monaco-editor';
import { useWorkspaceStore } from '../../../state/workspace.js';

export interface SftpEditHandle {
  /** The Monaco model — disposed by the janitor when the tab closes. */
  model: MonacoNs.editor.ITextModel;
  /** Upload the current model value over SFTP; resolves true on success. */
  save: () => Promise<boolean>;
}

const handles = new Map<string, SftpEditHandle>();
const keyOf = (projectId: number, path: string): string => `${projectId}:${path}`;

let subscribed = false;
function ensureJanitor(): void {
  if (subscribed) return;
  subscribed = true;
  const openKeys = (state: ReturnType<typeof useWorkspaceStore.getState>): string[] =>
    state.openFiles
      .filter((f) => f.kind === 'sftp')
      .map((f) => keyOf(f.projectId, f.path));
  let prev = openKeys(useWorkspaceStore.getState());
  useWorkspaceStore.subscribe((state) => {
    const next = openKeys(state);
    if (next.length === prev.length && next.every((key, index) => key === prev[index])) return;
    const now = new Set(next);
    for (const k of prev) {
      if (now.has(k)) continue;
      const h = handles.get(k);
      if (h) {
        try {
          h.model.dispose();
        } catch {
          /* already disposed */
        }
        handles.delete(k);
      }
    }
    prev = next;
  });
}

/** Register the live model + save closure for an SFTP-edit tab (idempotent per mount). */
export function registerSftpEdit(projectId: number, path: string, handle: SftpEditHandle): void {
  ensureJanitor();
  handles.set(keyOf(projectId, path), handle);
}

/** Is there a live SFTP-edit session for this tab? (save router uses this.) */
export function isSftpEditOpen(projectId: number, path: string): boolean {
  return handles.has(keyOf(projectId, path));
}

/** Save an SFTP-edit tab via its registered upload closure. Returns false if none. */
export async function saveSftpEdit(projectId: number, path: string): Promise<boolean> {
  const h = handles.get(keyOf(projectId, path));
  return h ? h.save() : false;
}
