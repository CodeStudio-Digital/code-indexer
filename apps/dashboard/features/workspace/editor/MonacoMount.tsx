/**
 * Monaco editor mount — the actual code editing surface.
 *
 * Wrapped in React.lazy + Suspense from EditorPane so the Monaco bundle
 * (~5 MB gzip) doesn't show up in the initial dashboard payload. Users
 * who never open the Workspace pay zero for the editor.
 *
 * Theme picks dark/light dynamically from the document's `.dark` class
 * (set by AppShell's theme toggle). Language inference is by extension —
 * Monaco's own registry handles 80+ languages out of the box.
 *
 * Day 7 wiring:
 *   - onChange pushes content into the workspace store, flagging dirty
 *   - Ctrl/Cmd+S calls files.write and clears the dirty flag
 *   - Tab switches re-create the model (Monaco keeps undo history per
 *     model — the editor instance is reused, the model swaps)
 */

import { useCallback, useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../lib/api-client.js';
import { useWorkspaceStore, type OpenFile } from '../../../state/workspace.js';

/** Map common file extensions to Monaco language ids. */
function inferLanguage(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'ts': case 'cts': case 'mts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js': case 'cjs': case 'mjs': return 'javascript';
    case 'jsx': return 'javascript';
    case 'json': return 'json';
    case 'md': case 'markdown': return 'markdown';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'html': case 'htm': return 'html';
    case 'xml': return 'xml';
    case 'yaml': case 'yml': return 'yaml';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'cs': return 'csharp';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': return 'cpp';
    case 'c': case 'h': return 'c';
    case 'sql': return 'sql';
    case 'sh': case 'bash': return 'shell';
    case 'ps1': return 'powershell';
    case 'dockerfile': return 'dockerfile';
    default: return 'plaintext';
  }
}

function detectDarkMode(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('dark');
}

interface MonacoMountProps {
  file: OpenFile;
}

export function MonacoMount({ file }: MonacoMountProps) {
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const setContent = useWorkspaceStore((s) => s.setContent);
  const markClean = useWorkspaceStore((s) => s.markClean);

  const handleMount = useCallback<OnMount>((editor) => {
    editorRef.current = editor;
  }, []);

  const handleChange = useCallback(
    (value: string | undefined) => {
      // Monaco emits undefined when the model is being swapped out; ignore
      // those — only real edits should flag dirty.
      if (value === undefined) return;
      if (value === file.content) return;
      setContent(file.path, value);
    },
    [file.path, file.content, setContent],
  );

  // Ctrl/Cmd+S → write current buffer to disk. Bound via window listener
  // rather than Monaco's keybindings so saves work even when focus is on
  // the tab bar or any other Workspace surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey && !e.altKey;
      if (!isSave) return;
      e.preventDefault();
      // Read latest content from the live editor (the store may lag by a
      // microtask after the last keystroke).
      const value = editorRef.current?.getValue() ?? file.content;
      void apiCall<{ ok: true; last_modified: string }>('files.write', {
        projectId: file.projectId,
        path: file.path,
        content: value,
      })
        .then((res) => {
          markClean(file.path, res.last_modified);
        })
        .catch((err) => {
          // Surface to console for now; a Day-7-late polish item is a
          // toast/banner near the editor. Don't swallow silently — the
          // dirty flag stays so the user knows it didn't persist.
          console.error('[workspace] save failed:', err);
        });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file.projectId, file.path, file.content, markClean]);

  const language = inferLanguage(file.path);
  const dark = detectDarkMode();

  return (
    <Editor
      height="100%"
      width="100%"
      // Key forces model recreation when the file changes, so undo history
      // doesn't leak across tabs.
      path={file.path}
      value={file.content}
      defaultLanguage={language}
      language={language}
      theme={dark ? 'vs-dark' : 'vs'}
      onMount={handleMount}
      onChange={handleChange}
      options={{
        fontSize: 13,
        fontFamily: 'Geist Mono, Cascadia Code, Consolas, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        wordWrap: 'off',
        tabSize: 2,
        renderLineHighlight: 'line',
        // The default scrollbars are okay; we hide the rulers since most
        // projects don't have a single shared line-length convention.
        rulers: [],
      }}
    />
  );
}
