/**
 * Query console: a Monaco SQL editor (schema-aware autocomplete, Cmd/Ctrl+Enter
 * to run the selection or the whole buffer) over a results grid, for the active
 * connection. Cancel aborts an in-flight query; each run is written to history.
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Square, Loader2 } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../../../components/ui/button.js';
import * as api from '../api.js';
import { ResultTable } from '../grid/ResultTable.js';
import { SqlEditor } from './SqlEditor.js';
import type { DbQueryResult } from '../types.js';

export function QueryConsole({
  projectId,
  connectionId,
  suggestions = [],
  schema,
}: {
  projectId: number;
  connectionId: number | null;
  suggestions?: string[];
  /** When set, the console is scoped to this schema (pg search_path / mysql USE). */
  schema?: string;
}) {
  const { t } = useTranslation('dbClient');
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);

  const run = useCallback(
    async (text: string) => {
      if (connectionId == null || !text.trim() || runningRef.current) return;
      runningRef.current = true;
      const cid = String(connectionId);
      const queryId = crypto.randomUUID();
      queryIdRef.current = queryId;
      setRunning(true);
      setError(null);
      const started = Date.now();
      try {
        const res = await api.runQuery(cid, text, { queryId, schema });
        setResult(res);
        void api
          .addHistory(projectId, connectionId, {
            sql: text,
            duration_ms: res.durationMs ?? Date.now() - started,
            row_count: res.rowCount,
            status: 'ok',
          })
          .catch(() => void 0);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setResult(null);
        void api.addHistory(projectId, connectionId, { sql: text, status: 'error', error_message: msg }).catch(() => void 0);
      } finally {
        runningRef.current = false;
        setRunning(false);
        queryIdRef.current = null;
      }
    },
    [connectionId, projectId],
  );

  const cancel = useCallback(() => {
    if (connectionId != null && queryIdRef.current) void api.cancelQuery(String(connectionId), queryIdRef.current);
  }, [connectionId]);

  if (connectionId == null) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">{t('query.noActive')}</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        {running ? (
          <Button size="sm" variant="outline" onClick={cancel}>
            <Square className="mr-1.5 h-3 w-3" />
            {t('query.cancel')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => void run(sql)} disabled={!sql.trim()}>
            <Play className="mr-1.5 h-3 w-3" />
            {t('query.run')}
          </Button>
        )}
        {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {schema && (
          <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-400" title={'search_path'}>
            {schema}
          </span>
        )}
        <div className="flex-1" />
        {result && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {result.rowCount} {t('query.rows')}
            {result.truncated ? ' ⚠' : ''}
            {result.durationMs != null ? ` · ${result.durationMs} ${t('query.elapsed')}` : ''}
          </span>
        )}
      </div>

      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        <Panel defaultSize={40} minSize={15}>
          <SqlEditor value={sql} onChange={setSql} onRun={(s) => void run(s)} suggestions={suggestions} height="100%" />
        </Panel>
        <PanelResizeHandle className="h-px bg-border hover:bg-accent" />
        <Panel minSize={20}>
          <div className="h-full overflow-auto">
            <ResultTable result={result} error={error} />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
