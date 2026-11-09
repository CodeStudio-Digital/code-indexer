/**
 * Query console: a Monaco SQL editor (schema-aware autocomplete) over a results
 * area, for the active connection.
 *
 *  - Cmd/Ctrl+Enter runs the selection (or the whole buffer if no selection).
 *  - Cmd/Ctrl+Shift+Enter runs the whole buffer.
 * Multiple `;`-separated statements run in sequence and show as N result-set
 * sub-tabs (stops at the first error). A bottom status bar shows rows / time /
 * statement count / the schema scope. Each run is written to history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Square, Loader2, Save, Network, WandSparkles, ShieldCheck } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { confirm, prompt, toast } from '../../../components/ui/prompt-dialog.js';
import * as api from '../api.js';
import { VirtualResultGrid } from '../grid/VirtualResultGrid.js';
import { SubTabs } from '../../api-client/SubTabs.js';
import { SqlEditor } from './SqlEditor.js';
import { ExplainPlanView } from './ExplainPlanView.js';
import { splitStatements } from './sql-split.js';
import { formatSql } from './format-sql.js';
import {
  analyzeSql,
  bindNamedParameters,
  findNamedParameters,
  parseParameterValue,
  type SqlTableReference,
} from './sql-intelligence.js';
import {
  DEFAULT_QUERY_TIMEOUT_SECONDS,
  MAX_QUERY_TIMEOUT_SECONDS,
  MIN_QUERY_TIMEOUT_SECONDS,
  queryTimeoutMsFromSeconds,
} from './query-timeout.js';
import type { DbEngine, DbQueryResult } from '../types.js';

interface ResultSet {
  sql: string;
  result?: DbQueryResult;
  error?: string;
  kind?: 'query' | 'plan';
}

export function QueryConsole({
  projectId,
  connectionId,
  connKey,
  suggestions = [],
  engine,
  schema,
  initialSql,
  onSaved,
  onSqlChange,
}: {
  projectId: number;
  connectionId: number | null;
  /** Live-op routing key (`id` or `id@db`); falls back to the numeric id. */
  connKey?: string;
  suggestions?: string[];
  /** Engine — feeds dialect-specific autocomplete. */
  engine?: DbEngine;
  /** When set, the console is scoped to this schema (pg search_path / mysql USE). */
  schema?: string;
  /** Initial SQL when opened from history / a saved query. */
  initialSql?: string;
  /** Called after saving a query, so a side panel can refresh. */
  onSaved?: () => void;
  /** Debounced draft hook used by workspace tab persistence. */
  onSqlChange?: (sql: string) => void;
}) {
  const { t } = useTranslation('dbClient');
  const [sql, setSql] = useState(initialSql ?? '');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultSet[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_QUERY_TIMEOUT_SECONDS));
  const [transactional, setTransactional] = useState(true);
  const [catalogCursor, setCatalogCursor] = useState<string | undefined>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogNames, setCatalogNames] = useState<string[]>([]);
  const catalogRequest = useRef<AbortController | null>(null);
  const queryIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const onSqlChangeRef = useRef(onSqlChange);
  onSqlChangeRef.current = onSqlChange;
  const allSuggestions = useMemo(
    () => [...new Set([...suggestions, ...catalogNames])],
    [catalogNames, suggestions],
  );

  useEffect(() => {
    if (!onSqlChangeRef.current) return;
    const timeout = setTimeout(() => onSqlChangeRef.current?.(sql), 300);
    return () => clearTimeout(timeout);
  }, [sql]);

  useEffect(() => {
    const controller = new AbortController();
    catalogRequest.current = controller;
    setCatalogNames([]); setCatalogCursor(undefined);
    setCatalogLoading(false);
    if (connectionId != null && engine !== 'mongodb' && engine !== 'redis') {
      void api.catalog(connKey ?? api.connectionKey(projectId, connectionId), false, { schema, limit: 300 }, controller.signal).then((snapshot) => {
        if (!controller.signal.aborted) { setCatalogNames(snapshot.objects.filter((object) => object.kind === 'table' || object.kind === 'view').map((object) => object.name)); setCatalogCursor(snapshot.nextCursor); }
      }).catch(() => void 0);
    }
    return () => { controller.abort(); };
  }, [connectionId, connKey, engine, projectId, schema]);

  const loadCatalogPage = async () => {
    if (!catalogCursor || catalogLoading || connectionId == null) return;
    const controller = catalogRequest.current;
    if (!controller || controller.signal.aborted) return;
    setCatalogLoading(true);
    try {
      const page = await api.catalog(connKey ?? api.connectionKey(projectId, connectionId), false, { schema, limit: 300, cursor: catalogCursor }, controller.signal);
      if (controller.signal.aborted) return;
      setCatalogNames(current => [...new Set([...current, ...page.objects.map(object => object.name)])].slice(0, 5000));
      setCatalogCursor(page.nextCursor);
    } finally { if (!controller.signal.aborted) setCatalogLoading(false); }
  };

  const run = useCallback(
    async (text: string) => {
      if (connectionId == null || runningRef.current) return;
      const statements = splitStatements(text);
      if (statements.length === 0) return;
      const safetyDiagnostics = analyzeSql(text, allSuggestions).filter((item) =>

        item.code === 'write-without-where' || item.code === 'destructive-ddl',
      );
      if (safetyDiagnostics.length > 0 && !(await confirm({
        title: t('query.unsafeTitle'),
        description: safetyDiagnostics.map((item) => t(`query.diagnostic.${item.code}`)).join('\n'),
        confirmLabel: t('query.runAnyway'),
        tone: 'destructive',
      }))) return;
      const parameterValues: Record<string, unknown> = {};
      for (const name of findNamedParameters(text)) {
        const value = await prompt({
          title: t('query.parameterTitle', { name }),
          placeholder: t('query.parameterPlaceholder'),
          confirmLabel: t('query.parameterApply'),
        });
        if (value == null) return;
        parameterValues[name] = parseParameterValue(value);
      }
      const boundStatements = statements.map((statement) => bindNamedParameters(statement, parameterValues, engine));
      const timeoutMs = queryTimeoutMsFromSeconds(timeoutSeconds);
      if (timeoutMs == null) {
        toast.error(t('query.timeoutInvalid', { min: MIN_QUERY_TIMEOUT_SECONDS, max: MAX_QUERY_TIMEOUT_SECONDS }));
        return;
      }
      runningRef.current = true;
      setRunning(true);
      const cid = connKey ?? api.connectionKey(projectId, connectionId);
      const out: ResultSet[] = [];
      const started = Date.now();
      let totalRows = 0;
      let failed: string | null = null;
      try {
        if (transactional && statements.length > 1) {
          const queryId = crypto.randomUUID();
          queryIdRef.current = queryId;
          try {
            const batch = await api.runQueryBatch(
              cid,
              boundStatements,
              { queryId, schema, timeoutMs },
            );
            batch.results.forEach((result, index) => {
              out.push({ sql: statements[index], result });
              totalRows += result.rowCount;
            });
          } catch (e) {
            failed = e instanceof Error ? e.message : String(e);
            out.push({ sql: text, error: failed });
          }
        } else {
          for (const stmt of statements) {
            const queryId = crypto.randomUUID();
            queryIdRef.current = queryId;
            try {
              const bound = boundStatements[out.length];
              const res = await api.runQuery(cid, bound.sql, { params: bound.params, queryId, schema, timeoutMs });
              out.push({ sql: stmt, result: res });
              totalRows += res.rowCount;
            } catch (e) {
              failed = e instanceof Error ? e.message : String(e);
              out.push({ sql: stmt, error: failed });
              break;
            }
          }
        }
      } finally {
        queryIdRef.current = null;
        runningRef.current = false;
        setRunning(false);
      }
      setResults(out);
      setActiveIdx(out.length - 1);
      void api
        .addHistory(projectId, connectionId, {
          sql: text,
          duration_ms: Date.now() - started,
          row_count: totalRows,
          status: failed ? 'error' : 'ok',
          error_message: failed,
        })
        .catch(() => void 0);
    },
    [allSuggestions, connectionId, connKey, engine, projectId, schema, t, timeoutSeconds, transactional],
  );

  const resolveColumns = useCallback(async (reference: SqlTableReference) => {
    if (connectionId == null) return [];
    const fallbackSchema = engine === 'mssql' ? 'dbo' : engine === 'postgres' ? 'public' : '';
    const info = await api.describeTable(
      connKey ?? api.connectionKey(projectId, connectionId),
      reference.schema ?? schema ?? fallbackSchema,
      reference.table,
    );
    return info.columns;
  }, [connectionId, connKey, engine, projectId, schema]);

  const cancel = useCallback(() => {
    if (connectionId != null && queryIdRef.current) void api.cancelQuery(connKey ?? api.connectionKey(projectId, connectionId), queryIdRef.current);
  }, [connectionId, connKey]);

  const format = useCallback(() => setSql((s) => formatSql(s)), []);

  const explain = useCallback(async () => {
    if (connectionId == null || !sql.trim() || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const res = await api.explain(connKey ?? api.connectionKey(projectId, connectionId), sql);
      setResults([{ sql, result: res, kind: 'plan' }]);
    } catch (e) {
      setResults([{ sql, error: e instanceof Error ? e.message : String(e) }]);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setActiveIdx(0);
    }
  }, [connectionId, connKey, sql]);

  const save = useCallback(async () => {
    if (!sql.trim()) return;
    const name = await prompt({ title: t('query.saveTitle'), placeholder: t('query.saveName'), confirmLabel: t('dialog.save') });
    if (!name?.trim()) return;
    try {
      await api.createSavedQuery(projectId, { connection_id: connectionId, name: name.trim(), sql });
      toast.success(t('query.saved'));
      onSaved?.();
    } catch (e) {
      toast.error(t('query.saveFail'), { description: e instanceof Error ? e.message : String(e) });
    }
  }, [sql, projectId, connectionId, t, onSaved]);

  if (connectionId == null) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">{t('query.noActive')}</div>;
  }

  const active = results[activeIdx];

  return (
    <div className="flex h-full flex-col">
      {catalogCursor && <div role="status" className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
        {t('query.catalogPartial')}
        <button type="button" disabled={catalogLoading || catalogNames.length >= 5000} onClick={() => void loadCatalogPage().catch(() => undefined)}>{t('query.loadCatalogPage')}</button>
      </div>}
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
        <Button size="sm" variant="ghost" onClick={() => void explain()} disabled={!sql.trim() || running} title={t('query.explain')}>
          <Network className="mr-1.5 h-3 w-3" />
          {t('query.explain')}
        </Button>
        <Button size="sm" variant="ghost" onClick={format} disabled={!sql.trim()} title={t('query.format')}>
          <WandSparkles className="h-3 w-3" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void save()} disabled={!sql.trim()} title={t('query.saveTitle')}>
          <Save className="h-3 w-3" />
        </Button>
        <Button
          size="sm"
          variant={transactional ? 'outline' : 'ghost'}
          onClick={() => setTransactional((value) => !value)}
          disabled={running}
          title={transactional ? t('query.transactionalOn') : t('query.transactionalOff')}
          aria-pressed={transactional}
        >
          <ShieldCheck className="mr-1.5 h-3 w-3" />
          {t('query.transactional')}
        </Button>
        <label className="ml-auto flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
          {t('query.timeout')}
          <Input
            aria-label={t('query.timeout')}
            className="h-7 w-16 px-2 text-xs"
            disabled={running}
            inputMode="numeric"
            max={MAX_QUERY_TIMEOUT_SECONDS}
            min={MIN_QUERY_TIMEOUT_SECONDS}
            step={1}
            type="number"
            value={timeoutSeconds}
            onChange={(event) => setTimeoutSeconds(event.target.value)}
          />
        </label>
      </div>

      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        <Panel defaultSize={40} minSize={15}>
          <SqlEditor
            value={sql}
            onChange={setSql}
            onRun={(s) => void run(s)}
            onRunAll={(s) => void run(s)}
            onFormat={format}
            suggestions={allSuggestions}
            resolveColumns={resolveColumns}
            engine={engine}
            height="100%"
          />
        </Panel>
        <PanelResizeHandle className="h-px bg-border hover:bg-accent" />
        <Panel minSize={20}>
          <div className="flex h-full flex-col">
            {results.length > 1 && (
              <SubTabs
                tabs={results.map((r, i) => ({
                  id: String(i),
                  label: `${t('query.result')} ${i + 1}`,
                  badge: r.error ? 1 : r.result?.rowCount,
                  badgeTone: r.error ? ('danger' as const) : ('primary' as const),
                }))}
                active={String(activeIdx)}
                onChange={(id) => setActiveIdx(Number(id))}
              />
            )}
            <div className="min-h-0 flex-1">
              {active?.kind === 'plan' && active.result
                ? <ExplainPlanView result={active.result} />
                : <VirtualResultGrid result={active?.result ?? null} error={active?.error ?? null} />}
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Status bar */}
      <div className="flex h-6 shrink-0 items-center gap-2 border-t bg-card/40 px-2 text-[11px] text-muted-foreground">
        {schema && (
          <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 text-[10px] text-sky-400" title={'search_path'}>
            {schema}
          </span>
        )}
        {active?.error ? (
          <span className="truncate text-red-400">{active.error}</span>
        ) : active?.result ? (
          <span className="tabular-nums">
            {active.result.rowCount} {t('query.rows')}
            {active.result.truncated ? ' ⚠' : ''}
            {active.result.durationMs != null ? ` · ${active.result.durationMs} ${t('query.elapsed')}` : ''}
          </span>
        ) : (
          <span>{t('query.idle')}</span>
        )}
        <div className="flex-1" />
        {results.length > 1 && <span className="tabular-nums">{t('query.statementsN', { n: results.length })}</span>}
      </div>
    </div>
  );
}
