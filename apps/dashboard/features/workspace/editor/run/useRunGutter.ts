/**
 * React glue that lights up the run gutter inside MonacoMount, for any
 * package.json / composer.json scripts, Maven/Gradle/.NET project manifests,
 * runnable source files, and fenced code blocks of markdown files. Gated on "content loaded"
 * (a boolean) so it doesn't re-attach on every keystroke — live updates are
 * handled inside attachRunGutter via the model's onDidChangeContent.
 */

import { useEffect } from 'react';
import type * as MonacoNs from 'monaco-editor';
import type { OpenFile } from '../../../../state/workspace.js';
import { attachRunGutter } from './run-gutter.js';

export function useRunGutter(
  file: OpenFile,
  editor: MonacoNs.editor.IStandaloneCodeEditor | null,
  monaco: typeof MonacoNs | null,
): void {
  const hasContent = file.content !== null;

  useEffect(() => {
    if (!editor || !monaco || !hasContent) return;
    if (file.kind && file.kind !== 'file') return; // skip virtual tabs
    const base = (file.path.split('/').pop() ?? '').toLowerCase();
    const eligible =
      base === 'package.json' || base === 'composer.json' ||
      base === 'pom.xml' || base === 'build.gradle' || base === 'build.gradle.kts' || base.endsWith('.csproj') ||
      base.endsWith('.py') || base.endsWith('.java') || base.endsWith('.cs') ||
      base.endsWith('.md') || base.endsWith('.markdown');
    if (!eligible) return;
    const handle = attachRunGutter(editor, monaco, file);
    return () => handle.dispose();
  }, [editor, monaco, hasContent, file.path, file.projectId, file.kind]);
}
