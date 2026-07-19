import { useEffect } from 'react';
import type * as MonacoNs from 'monaco-editor';
import type { OpenFile } from '../../../state/workspace.js';
import { useContributions } from '../../../state/contribution-registry.js';
import { attachPluginEditorGutter } from './plugin-editor-gutter.js';
import { choosePluginGutterMarker, runPluginEditorAction } from './plugin-editor-action-runner.js';

export function usePluginEditorGutter(
  file: OpenFile,
  editor: MonacoNs.editor.IStandaloneCodeEditor | null,
  monaco: typeof MonacoNs | null,
): void {
  const actions = useContributions((state) => state.editorActions);
  const hasContent = file.content !== null;

  useEffect(() => {
    if (!editor || !monaco || !hasContent || (file.kind && file.kind !== 'file')) return;
    let active = true;
    let choosing = false;
    const handle = attachPluginEditorGutter(editor, monaco, file, actions, (markers) => {
      if (choosing) return;
      choosing = true;
      void choosePluginGutterMarker(markers).then((marker) => {
        if (active && marker) return runPluginEditorAction(marker.action, file.projectId, marker.context);
        return undefined;
      }).finally(() => {
        choosing = false;
      });
    });
    return () => {
      active = false;
      handle.dispose();
    };
  }, [actions, editor, file.kind, file.path, file.projectId, hasContent, monaco]);
}
