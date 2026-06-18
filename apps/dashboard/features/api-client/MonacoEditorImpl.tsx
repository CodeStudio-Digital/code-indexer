/**
 * Actual Monaco surface for the API client (loaded lazily via LazyMonaco so the
 * ~5MB bundle stays out of the tab's initial payload). Uses the locally-bundled
 * monaco (setupMonaco) — NOT the workspace MonacoMount, which is welded to the
 * workspace store + LSP. A thin controlled editor: value in, onChange out.
 */
import Editor, { type OnMount } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import { setupMonaco } from '../../lib/monaco-setup.js';
import type { CodeEditorProps } from './LazyMonaco.js';

setupMonaco();

export default function MonacoEditorImpl({ value, language, readOnly, onChange, height = '100%', onMount }: CodeEditorProps) {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const handleMount: OnMount = (editor, monaco) => { onMount?.(editor, monaco); };
  return (
    <Editor
      height={height}
      language={language ?? 'plaintext'}
      value={value}
      theme={isDark ? 'vs-dark' : 'light'}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={handleMount}
      loading={<div className="h-full flex items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: readOnly ? 'off' : 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        automaticLayout: true,
        tabSize: 2,
        folding: true,
        renderLineHighlight: 'none',
        overviewRulerLanes: 0,
      }}
    />
  );
}
