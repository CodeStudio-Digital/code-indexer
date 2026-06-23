/**
 * Save path shared by Ctrl+S, the command registry (Onda 6) and future
 * save-all: reads the LIVE Monaco model when present (the store can lag a
 * microtask behind the last keystroke), falls back to the store mirror.
 */
import { apiCall } from '../../../lib/api-client.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { modelFor } from './editor-models.js';
import { saveSftpEdit } from './sftp-edit-session.js';

export async function saveFile(projectId: number, path: string): Promise<boolean> {
  // Remote (sftp) tabs re-upload over SFTP instead of writing to the project FS.
  const open = useWorkspaceStore.getState().openFiles.find((f) => f.path === path && f.projectId === projectId);
  if (open?.kind === 'sftp') return saveSftpEdit(projectId, path);

  const tab = useWorkspaceStore.getState().openFiles.find(
    (f) => (f.kind === undefined || f.kind === 'file') && f.path === path && f.projectId === projectId,
  );
  const stored = tab && (tab.kind === undefined || tab.kind === 'file') ? tab.content : null;
  const value = modelFor(projectId, path)?.getValue() ?? stored;
  if (value == null) return false; // never-loaded tab — nothing to persist
  try {
    const res = await apiCall<{ ok: true; last_modified: string }>('files.write', {
      projectId, path, content: value,
    });
    useWorkspaceStore.getState().markClean(projectId, path, res.last_modified);
    return true;
  } catch (err) {
    console.error('[workspace] save failed:', err);
    return false;
  }
}

/** Save every dirty tab of the project (local files + remote sftp edits). Returns how many persisted. */
export async function saveAllDirty(projectId: number): Promise<number> {
  const dirty = useWorkspaceStore.getState().openFiles.filter(
    (f) =>
      (f.kind === undefined || f.kind === 'file' || f.kind === 'sftp') &&
      f.projectId === projectId &&
      f.dirty,
  );
  let saved = 0;
  for (const f of dirty) {
    if (await saveFile(projectId, f.path)) saved++;
  }
  return saved;
}
