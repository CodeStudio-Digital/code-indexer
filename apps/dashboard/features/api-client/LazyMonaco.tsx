/**
 * Lazy Monaco wrapper — code-splits the editor bundle. Reused by the body JSON/
 * raw editor, the response Pretty pane, the scripts editor and the code dialog.
 */
import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import type { editor } from 'monaco-editor';

export interface CodeEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
  height?: string | number;
  onMount?: (editor: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => void;
}

const Inner = lazy(() => import('./MonacoEditorImpl.js'));

export function LazyMonaco(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div className="h-full flex items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}>
      <Inner {...props} />
    </Suspense>
  );
}
