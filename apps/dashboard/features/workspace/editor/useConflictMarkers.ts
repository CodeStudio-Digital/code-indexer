/**
 * React glue that lights up conflict-marker UI inside MonacoMount. When
 * the open file is flagged conflicted (and actually still carries markers),
 * it attaches decorations + Accept Current/Incoming/Both CodeLens; it
 * disposes on unmount, on a model swap (path change), or once the file
 * leaves the conflict set / is resolved in-buffer.
 */

import { useEffect } from 'react';
import type * as MonacoNs from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import type { OpenFile } from '../../../state/workspace.js';
import { useIsConflicted } from './conflict-registry.js';
import { attachConflictUI, hasConflictMarkers } from './conflict-markers.js';

export function useConflictMarkers(
  file: OpenFile,
  editor: MonacoNs.editor.IStandaloneCodeEditor | null,
  monaco: typeof MonacoNs | null,
): void {
  const { t } = useTranslation('workspace');
  const conflicted = useIsConflicted(file.projectId, file.path);
  // Gate on "content has loaded" (a boolean) rather than the content value —
  // otherwise this re-runs on every keystroke (the store mirrors edits) and
  // thrashes the CodeLens provider. Live updates are handled inside
  // attachConflictUI via the model's own onDidChangeContent.
  const hasContent = file.content !== null;

  useEffect(() => {
    if (!editor || !monaco || !conflicted || !hasContent) return;
    const model = editor.getModel();
    // Self-gate: a terminal-side resolve may have cleared the markers while
    // the registry is still stale — don't decorate a clean file.
    if (!model || !hasConflictMarkers(model.getValue())) return;
    const handle = attachConflictUI(editor, monaco, {
      current: t('git.conflict.acceptCurrent'),
      incoming: t('git.conflict.acceptIncoming'),
      both: t('git.conflict.acceptBoth'),
    });
    return () => handle.dispose();
  }, [editor, monaco, conflicted, hasContent, file.path, t]);
}
