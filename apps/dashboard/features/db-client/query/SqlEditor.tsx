/**
 * Monaco SQL editor for the query console. Reuses the api-client's lightweight
 * `LazyMonaco` (NOT the LSP-welded workspace editor). On mount it:
 *   - registers a schema-aware completion provider (table/column names) scoped
 *     to THIS editor's model and disposed when the editor goes away;
 *   - binds Cmd/Ctrl+Enter to run the selection (or the whole buffer).
 * SQL keywords come from Monaco's built-in `sql` language; identifiers come from
 * the live introspection cache via `suggestions`.
 */
import { useRef } from 'react';
import type { editor } from 'monaco-editor';
import { LazyMonaco } from '../../api-client/LazyMonaco.js';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'VALUES', 'SET',
  'JOIN', 'LEFT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'HAVING',
  'AND', 'OR', 'NOT', 'NULL', 'AS', 'ON', 'DISTINCT', 'COUNT', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
];

export function SqlEditor({
  value,
  onChange,
  onRun,
  suggestions,
  height,
}: {
  value: string;
  onChange: (v: string) => void;
  onRun: (sql: string) => void;
  suggestions: string[];
  height?: string | number;
}) {
  const suggRef = useRef(suggestions);
  suggRef.current = suggestions;
  const runRef = useRef(onRun);
  runRef.current = onRun;

  function onMount(ed: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')): void {
    const provider = monaco.languages.registerCompletionItemProvider('sql', {
      provideCompletionItems(model, position) {
        if (model !== ed.getModel()) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const idents = suggRef.current.map((name) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: name,
          range,
        }));
        const kw = KEYWORDS.map((name) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: name,
          range,
        }));
        return { suggestions: [...idents, ...kw] };
      },
    });

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const sel = ed.getSelection();
      const selected = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) : null;
      runRef.current(selected || ed.getValue());
    });

    ed.onDidDispose(() => provider.dispose());
  }

  return <LazyMonaco value={value} language="sql" onChange={onChange} onMount={onMount} height={height} />;
}
