/**
 * Lazy tab content: tabs open with `content: null` (instant); the ACTIVE
 * surface (MonacoMount / MarkdownView) calls this to fetch on first
 * activation. When the tab already has content + mtime, revalidates via
 * `ifModifiedSince` — a stat on the backend, no payload when unchanged.
 */
import { useEffect } from 'react';
import { apiCall } from '../../../lib/api-client.js';
import { useWorkspaceStore, type OpenFile } from '../../../state/workspace.js';
import { applyExternalContent } from './editor-models.js';

type ReadResult =
  | { content: string; encoding: 'utf8' | 'base64'; last_modified: string }
  | { notModified: true; last_modified: string };

export function useEnsureFileContent(file: OpenFile): void {
  const needsFetch = file.content === null;
  const revalidateKey = file.content !== null && !file.dirty ? file.lastModified : null;

  useEffect(() => {
    let cancelled = false;
    // Never clobber unsaved edits with a background revalidation.
    if (file.dirty) return;
    if (!needsFetch && revalidateKey === null) return;
    void apiCall<ReadResult>('files.read', {
      projectId: file.projectId,
      path: file.path,
      ifModifiedSince: needsFetch ? undefined : revalidateKey ?? undefined,
    })
      .then((res) => {
        if (cancelled || 'notModified' in res) return;
        // A keystroke can land after the request resolves but before React has
        // run this effect's cleanup. Consult the live store at commit time so
        // a stale disk response can never replace an unsaved buffer.
        const current = useWorkspaceStore.getState().openFiles.find((candidate) =>
          candidate.projectId === file.projectId && candidate.path === file.path);
        if (!current || (current.kind && current.kind !== 'file') || current.dirty) return;
        applyExternalContent(file.projectId, file.path, res.content, res.last_modified);
      })
      .catch(() => {
        /* deleted/unreadable — the fs-events stream surfaces the delete */
      });
    return () => { cancelled = true; };
    // Activation identity and dirty transitions drive the fetch. In particular,
    // do not depend on `needsFetch`: the initial response changes null → string
    // and previously triggered an immediate redundant files.read/stat request.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path activation intentionally snapshots read metadata once
  }, [file.projectId, file.path, file.dirty]);
}
