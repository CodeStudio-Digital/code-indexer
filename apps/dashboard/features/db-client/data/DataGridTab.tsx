/**
 * Table-data tab (double-click a table). Shows the rows paginated (server-side
 * LIMIT/OFFSET) in an EDITABLE grid when the table has a primary key — edit
 * cells / add / delete rows, then preview the generated SQL and apply. An in-tab
 * SQL bar (pre-filled `SELECT * FROM <table>`) runs arbitrary SQL right here;
 * custom-SQL results are shown read-only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RotateCcw, ChevronLeft, ChevronRight, RefreshCw, Loader2, Eye, Undo2, Check } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { confirm, toast } from '../../../components/ui/prompt-dialog.js';
import * as api from '../api.js';
import { VirtualResultGrid } from '../grid/VirtualResultGrid.js';
import { SqlPreviewDialog } from '../grid/SqlPreviewDialog.js';
import { useGridEdits } from '../grid/use-grid-edits.js';
import { SqlEditor } from '../query/SqlEditor.js';
import { FilterBar } from './FilterBar.js';
import type { DbColumn, DbEngine, DbQueryResult, DbTableSort, DbWhereCondition } from '../types.js';

const PAGE_SIZES = [50, 100, 200, 500];

export function DataGridTab({
  connKey,
  schema,
  table,
  engine,
}: {
  connKey: string;
  schema: string;
  table: string;
  engine?: DbEngine;
}) {
  const { t } = useTranslation('dbClient');
  const cid = connKey;
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'preview' | 'custom'>('preview');
  const [viewMode, setViewMode] = useState<'filter' | 'sql'>('filter');
  const [sql, setSql] = useState(`SELECT * FROM ${table}`);
  const [sort, setSort] = useState<DbTableSort | null>(null);
  const [where, setWhere] = useState<DbWhereCondition[]>([]);
  const [appliedWhere, setAppliedWhere] = useState<DbWhereCondition[]>([]);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [pkCols, setPkCols] = useState<string[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [columnMeta, setColumnMeta] = useState<DbColumn[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSql, setPreviewSql] = useState('');
  const [executing, setExecuting] = useState(false);
  const reqIdRef = useRef(0);
  const edits = useGridEdits();

  // Resolve the table's primary key once (drives editability + UPDATE/DELETE scoping).
  useEffect(() => {
    let cancelled = false;
    void api
      .describeTable(cid, schema, table)
      .then((info) => {
        if (!cancelled) {
          setPkCols(info.columns.filter((c) => c.isPrimaryKey).map((c) => c.name));
          setCols(info.columns.map((c) => c.name));
          setColumnMeta(info.columns);
        }
      })
      .catch(() => void 0);
    return () => {
      cancelled = true;
    };
  }, [cid, schema, table]);

  const loadPreview = useCallback(
    async (p: number, size: number) => {
      const myReq = ++reqIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.tableRows(cid, schema, table, size, p * size, sort ?? undefined, appliedWhere.length ? appliedWhere : undefined);
        if (myReq === reqIdRef.current) {
          setResult(res);
          edits.revertAll(); // a fresh page invalidates pending edits keyed by old rows
        }
      } catch (e) {
        if (myReq === reqIdRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          setResult(null);
        }
      } finally {
        if (myReq === reqIdRef.current) setLoading(false);
      }
    },
    // edits.revertAll is stable
    [cid, schema, table, edits, sort, appliedWhere],
  );

  useEffect(() => {
    if (mode === 'preview') void loadPreview(page, pageSize);
    // Table identity is deliberately explicit here. DatabaseEditorView also
    // keys the surface by tab path, but this keeps the grid correct if it is
    // ever embedded elsewhere without that reconciliation boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, page, pageSize, sort, appliedWhere, cid, schema, table]);

  // Click a column header → cycle asc → desc → unsorted, server-side, in place.
  const toggleSort = useCallback((col: string) => {
    setSort((s) => (!s || s.column !== col ? { column: col, dir: 'asc' } : s.dir === 'asc' ? { column: col, dir: 'desc' } : null));
    setPage(0);
  }, []);

  // Apply the visual filter (commits the edited conditions to the loaded query).
  const applyFilter = useCallback(() => {
    setAppliedWhere(where.filter((c) => c.column));
    setMode('preview');
    setPage(0);
  }, [where]);

  const toggleColumn = useCallback((col: string) => {
    setHiddenCols((s) => {
      const next = new Set(s);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  }, []);

  const runCustom = useCallback(async (override?: string) => {
    const q = (override ?? sql).trim();
    if (!q) return;
    const myReq = ++reqIdRef.current;
    setMode('custom');
    setLoading(true);
    setError(null);
    try {
      const res = await api.runQuery(cid, q);
      if (myReq === reqIdRef.current) setResult(res);
    } catch (e) {
      if (myReq === reqIdRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
      }
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [cid, sql]);

  const changesForApply = useCallback(
    () => edits.buildChanges(result?.rows ?? [], pkCols, schema, table),
    [edits, result, pkCols, schema, table],
  );

  const openPreview = useCallback(async () => {
    const changes = changesForApply();
    if (changes.length === 0) return;
    try {
      const sqls = await Promise.all(
        changes.map((c) =>
          api.editRow({ connectionId: cid, op: c.op, schema, table, pk: c.pk, values: c.values, dryRun: true }).then((r) => r.sql),
        ),
      );
      setPreviewSql(sqls.join(';\n') + ';');
      setPreviewOpen(true);
    } catch (e) {
      toast.error(t('edit.applyError'), { description: e instanceof Error ? e.message : String(e) });
    }
  }, [changesForApply, cid, schema, table, t]);

  const apply = useCallback(async () => {
    const changes = changesForApply();
    const deletes = changes.filter((change) => change.op === 'delete').length;
    if (deletes > 0 && !(await confirm({
      title: t('edit.deleteApplyConfirmTitle', { count: deletes }),
      description: t('edit.deleteApplyConfirmBody'),
      confirmLabel: t('edit.execute'),
      tone: 'destructive',
    }))) return;
    setExecuting(true);
    let applied = 0;
    try {
      for (const c of changes) {
        await api.editRow({ connectionId: cid, op: c.op, schema, table, pk: c.pk, values: c.values });
        applied += 1;
      }
      toast.success(t('edit.applied'));
    } catch (e) {
      // Some changes already committed — surface how many, then reset so a retry
      // can't re-run the already-applied ones (e.g. duplicate INSERTs).
      toast.error(t('edit.applyError'), { description: `${t('edit.applied')}: ${applied}/${changes.length} · ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      // Always clear the changeset + reload from the DB — the grid then reflects
      // actual state regardless of partial success.
      setPreviewOpen(false);
      edits.revertAll();
      await loadPreview(page, pageSize);
      setExecuting(false);
    }
  }, [changesForApply, cid, schema, table, t, edits, loadPreview, page, pageSize]);

  const editable = mode === 'preview' && pkCols.length > 0 && result != null && !error;
  const atLastPage = mode === 'preview' && result != null && result.rows.length < pageSize;

  return (
    <div className="flex h-full flex-col">
      {viewMode === 'filter' ? (
        <FilterBar
          columns={cols}
          conditions={where}
          onChange={setWhere}
          hidden={hiddenCols}
          onToggleColumn={toggleColumn}
          onApply={applyFilter}
          onOpenSql={() => setViewMode('sql')}
          loading={loading}
        />
      ) : (
        /* Raw SQL editor (Monaco, schema-aware autocomplete) */
        <div className="flex items-start gap-2 border-b p-1.5">
          <div className="min-w-0 flex-1 overflow-hidden rounded border">
            <SqlEditor
              value={sql}
              onChange={setSql}
              onRun={(text) => void runCustom(text)}
              suggestions={[table, ...cols]}
              engine={engine}
              height={64}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Button size="sm" onClick={() => void runCustom()} disabled={!sql.trim() || loading}>
              <Play className="mr-1.5 h-3 w-3" />
              {t('data.runSql')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setViewMode('filter'); setMode('preview'); }} title={t('filter.filterMode')}>
              <RotateCcw className="mr-1.5 h-3 w-3" />
              {t('filter.filterMode')}
            </Button>
          </div>
        </div>
      )}

      {/* Results */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading && (
          <div className="absolute right-2 top-2 z-30">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {mode === 'preview' && !error && pkCols.length === 0 && result != null && (
          <div className="border-b bg-amber-500/10 px-2 py-1 text-[11px] text-amber-400">{t('edit.noPk')}</div>
        )}
        <div className="min-h-0 flex-1">
          <VirtualResultGrid
            result={result}
            error={error}
            tableName={table}
            edits={editable ? edits : undefined}
            pkCols={editable ? pkCols : undefined}
            sort={mode === 'preview' ? sort : undefined}
            onSort={mode === 'preview' ? toggleSort : undefined}
            hiddenColumns={hiddenCols}
            columnMeta={columnMeta}
          />
        </div>
      </div>

      {/* Pending-changes bar */}
      {editable && edits.dirtyCount > 0 && (
        <div className="flex items-center gap-2 border-t bg-primary/5 px-2 py-1 text-xs">
          <Check className="h-3.5 w-3.5 text-primary" />
          <span className="text-muted-foreground">{t('edit.pending', { n: edits.dirtyCount })}</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={edits.revertAll}>
            <Undo2 className="mr-1.5 h-3 w-3" />
            {t('edit.revert')}
          </Button>
          <Button size="sm" onClick={() => void openPreview()}>
            <Eye className="mr-1.5 h-3 w-3" />
            {t('edit.preview')}
          </Button>
        </div>
      )}

      {/* Pager (preview mode only) */}
      {mode === 'preview' && (
        <div className="flex items-center gap-2 border-t px-2 py-1 text-xs">
          <button className="rounded p-1 hover:bg-muted" title={t('data.reload')} onClick={() => void loadPreview(page, pageSize)}>
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {pkCols.length > 0 && (
            <button
              className="rounded p-1 hover:bg-muted"
              title={t('edit.addRow')}
              onClick={edits.addRow}
            >
              +
            </button>
          )}
          <div className="flex-1" />
          <button
            className="rounded p-1 hover:bg-muted disabled:opacity-40"
            title={t('data.prev')}
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="tabular-nums text-muted-foreground">{t('data.page', { n: page + 1 })}</span>
          <button
            className="rounded p-1 hover:bg-muted disabled:opacity-40"
            title={t('data.next')}
            disabled={atLastPage || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <select
            className="h-6 rounded border bg-background px-1"
            value={pageSize}
            onChange={(e) => {
              setPage(0);
              setPageSize(Number(e.target.value));
            }}
            title={t('data.pageSize')}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      <SqlPreviewDialog
        open={previewOpen}
        sql={previewSql}
        executing={executing}
        onExecute={() => void apply()}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  );
}
