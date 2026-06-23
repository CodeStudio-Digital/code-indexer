/**
 * Minimal P0 query console: a SQL textarea + Run/Cancel and a plain (capped)
 * results table for the active connection. The full Monaco editor, schema-aware
 * autocomplete and virtualized grid land in P1 — this is enough to run a SELECT
 * and see rows end-to-end.
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Square, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import * as api from '../api.js';
import type { DbQueryResult } from '../types.js';

export function QueryConsole({
  projectId,
  connectionId,
}: {
  projectId: number;
  connectionId: number | null;
}) {
  const { t } = useTranslation('dbClient');
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryIdRef = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (connectionId == null || !sql.trim() || running) return;
    const cid = String(connectionId);
    const queryId = crypto.randomUUID();
    queryIdRef.current = queryId;
    setRunning(true);
    setError(null);
    const started = Date.now();
    try {
      const res = await api.runQuery(cid, sql, { queryId });
      setResult(res);
      void api
        .addHistory(projectId, connectionId, {
          sql,
          duration_ms: res.durationMs ?? Date.now() - started,
          row_count: res.rowCount,
          status: 'ok',
        })
        .catch(() => void 0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setResult(null);
      void api
        .addHistory(projectId, connectionId, { sql, status: 'error', error_message: msg })
        .catch(() => void 0);
    } finally {
      setRunning(false);
      queryIdRef.current = null;
    }
  }, [connectionId, sql, running, projectId]);

  const cancel = useCallback(() => {
    if (connectionId != null && queryIdRef.current) void api.cancelQuery(String(connectionId), queryIdRef.current);
  }, [connectionId]);

  function onKeyDown(e: React.KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  }

  if (connectionId == null) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">{t('query.noActive')}</div>;
  }

  const columns = result ? columnNames(result) : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        {running ? (
          <Button size="sm" variant="outline" onClick={cancel}>
            <Square className="mr-1.5 h-3 w-3" />
            {t('query.cancel')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => void run()} disabled={!sql.trim()}>
            <Play className="mr-1.5 h-3 w-3" />
            {t('query.run')}
          </Button>
        )}
        {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <div className="flex-1" />
        {result && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {result.rowCount} {t('query.rows')}
            {result.truncated ? ' ⚠' : ''}
            {result.durationMs != null ? ` · ${result.durationMs} ${t('query.elapsed')}` : ''}
          </span>
        )}
      </div>

      <textarea
        className="h-32 w-full resize-none border-b bg-background p-2 font-mono text-xs outline-none"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('query.placeholder')}
        spellCheck={false}
      />

      <div className="flex-1 overflow-auto">
        {error && <div className="m-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>}
        {result && !error && columns.length > 0 && (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-card">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="border-b border-r px-2 py-1 text-left font-medium text-muted-foreground">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="hover:bg-muted/40">
                  {columns.map((c) => (
                    <td key={c} className="max-w-[320px] truncate border-b border-r px-2 py-1 font-mono">
                      {cellText(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result && !error && result.rows.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground">
            {result.command ? `${result.command} · ${result.rowCount} ${t('query.affected')}` : t('query.empty')}
          </div>
        )}
      </div>
    </div>
  );
}

function columnNames(result: DbQueryResult): string[] {
  if (result.fields.length > 0) return result.fields.map((f) => f.name);
  return result.rows[0] ? Object.keys(result.rows[0]) : [];
}

function cellText(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
