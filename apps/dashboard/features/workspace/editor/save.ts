/**
 * Save path shared by Ctrl+S, the command registry (Onda 6) and future
 * save-all: reads the LIVE Monaco model when present (the store can lag a
 * microtask behind the last keystroke), falls back to the store mirror.
 */
import { apiCall } from '../../../lib/api-client.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { flushEditorContentMirror, getActiveEditor, modelFor } from './editor-models.js';
import { saveSftpEdit } from './sftp-edit-session.js';
import { getEffectiveEditorSettings } from '../../../state/editor-settings.js';

export async function saveFile(projectId: number, path: string): Promise<boolean> {
  // Remote (sftp) tabs re-upload over SFTP instead of writing to the project FS.
  const open = useWorkspaceStore.getState().openFiles.find((f) => f.path === path && f.projectId === projectId);
  if (open?.kind === 'sftp') return saveSftpEdit(projectId, path);

  const tab = useWorkspaceStore.getState().openFiles.find(
    (f) => (f.kind === undefined || f.kind === 'file') && f.path === path && f.projectId === projectId,
  );
  const stored = tab && (tab.kind === undefined || tab.kind === 'file') ? tab.content : null;
  const model = modelFor(projectId, path);
  const settings = getEffectiveEditorSettings(projectId, path);
  if (settings.formatOnSave && getActiveEditor()?.getModel() === model) {
    await getActiveEditor()?.getAction('editor.action.formatDocument')?.run();
  }
  if (model?.isDisposed()) return false;
  let value = model?.getValue() ?? stored;
  if (value == null) return false; // never-loaded tab — nothing to persist
  if (settings.trimTrailingWhitespace) value = value.replace(/[\t ]+$/gm, '');
  if (settings.insertFinalNewline && value && !value.endsWith('\n')) value += '\n';
  if (settings.endOfLine === 'lf') value = value.replace(/\r\n/g, '\n');
  if (settings.endOfLine === 'crlf') value = value.replace(/\r?\n/g, '\r\n');
  if (model && model.getValue() !== value) model.setValue(value);
  useWorkspaceStore.getState().syncEditorContent(projectId, path, value);
  try {
    const res = await apiCall<{ ok: true; last_modified: string }>('files.write', {
      projectId, path, content: value,
    });
    flushEditorContentMirror(modelFor(projectId, path));
    useWorkspaceStore.getState().markClean(projectId, path, res.last_modified, value);
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
