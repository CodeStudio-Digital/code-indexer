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
import { registerCommandHandlers } from '../../../keymap/commands.js';
import type { DbEngine } from '../types.js';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'VALUES', 'SET',
  'JOIN', 'LEFT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'HAVING',
  'AND', 'OR', 'NOT', 'NULL', 'AS', 'ON', 'DISTINCT', 'COUNT', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
];

/** Per-dialect functions, surfaced as Function completions on top of the identifiers. */
const FUNCTIONS_BY_ENGINE: Partial<Record<DbEngine, string[]>> = {
  postgres: ['COALESCE', 'NULLIF', 'NOW()', 'CURRENT_DATE', 'CAST', 'COUNT(*)', 'SUM', 'AVG', 'MAX', 'MIN', 'LOWER', 'UPPER', 'LENGTH', 'TO_CHAR', 'DATE_TRUNC', 'ARRAY_AGG', 'STRING_AGG', 'JSONB_BUILD_OBJECT'],
  mysql: ['IFNULL', 'COALESCE', 'NOW()', 'CURDATE()', 'CONCAT', 'CAST', 'COUNT(*)', 'SUM', 'AVG', 'MAX', 'MIN', 'LOWER', 'UPPER', 'LENGTH', 'DATE_FORMAT', 'GROUP_CONCAT', 'JSON_EXTRACT'],
  mariadb: ['IFNULL', 'COALESCE', 'NOW()', 'CURDATE()', 'CONCAT', 'CAST', 'COUNT(*)', 'SUM', 'AVG', 'MAX', 'MIN', 'LOWER', 'UPPER', 'LENGTH', 'DATE_FORMAT', 'GROUP_CONCAT', 'JSON_EXTRACT'],
  sqlite: ['IFNULL', 'COALESCE', 'COUNT(*)', 'SUM', 'AVG', 'MAX', 'MIN', 'LOWER', 'UPPER', 'LENGTH', "DATE('now')", "DATETIME('now')", 'STRFTIME', 'GROUP_CONCAT'],
  mssql: ['ISNULL', 'COALESCE', 'GETDATE()', 'CONVERT', 'CAST', 'COUNT(*)', 'SUM', 'AVG', 'MAX', 'MIN', 'LEN', 'UPPER', 'LOWER', 'FORMAT', 'STRING_AGG'],
  oracle: ['NVL', 'COALESCE', 'SYSDATE', 'TO_CHAR', 'TO_DATE', 'CAST', 'COUNT(*)', 'SUM', 'AVG', 'MAX', 'MIN', 'LENGTH', 'UPPER', 'LOWER', 'TRUNC', 'LISTAGG'],
};

export function SqlEditor({
  value,
  onChange,
  onRun,
  onRunAll,
  onFormat,
  suggestions,
  engine,
  height,
}: {
  value: string;
  onChange: (v: string) => void;
  onRun: (sql: string) => void;
  /** Run the whole buffer regardless of selection (Cmd/Ctrl+Shift+Enter). */
  onRunAll?: (sql: string) => void;
  /** Format the buffer (Cmd/Ctrl+Alt+L). */
  onFormat?: () => void;
  suggestions: string[];
  /** Engine — adds dialect-specific function completions. */
  engine?: DbEngine;
  height?: string | number;
}) {
  const suggRef = useRef(suggestions);
  suggRef.current = suggestions;
  const fnRef = useRef<string[]>([]);
  fnRef.current = (engine && FUNCTIONS_BY_ENGINE[engine]) || [];
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const runAllRef = useRef(onRunAll);
  runAllRef.current = onRunAll;
  const formatRef = useRef(onFormat);
  formatRef.current = onFormat;

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
        const fns = fnRef.current.map((name) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: name,
          range,
        }));
        return { suggestions: [...idents, ...fns, ...kw] };
      },
    });

    const unregisterCommands = registerCommandHandlers([
      {
        id: 'database.runQuery',
        when: () => ed.hasTextFocus(),
        run: () => {
          const sel = ed.getSelection();
          const selected = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) : null;
          runRef.current(selected || ed.getValue());
        },
      },
      {
        id: 'database.runAllQueries',
        when: () => ed.hasTextFocus(),
        run: () => (runAllRef.current ?? runRef.current)(ed.getValue()),
      },
      {
        id: 'database.formatQuery',
        when: () => ed.hasTextFocus() && Boolean(formatRef.current),
        run: () => formatRef.current?.(),
      },
    ]);

    ed.onDidDispose(() => {
      provider.dispose();
      unregisterCommands();
    });
  }

  return <LazyMonaco value={value} language="sql" onChange={onChange} onMount={onMount} height={height} />;
}
