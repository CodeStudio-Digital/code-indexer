/**
 * Document-store data tab (Mongo) — double-click a collection. Browses documents
 * paginated (server-side find with skip/limit) in the shared grid; a JSON filter
 * box runs find({...}); the pencil per row (or "Add") opens the JSON editor to
 * update/insert/delete. Mirrors DataGridTab but for collections, not tables.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RefreshCw, ChevronLeft, ChevronRight, Loader2, Plus, Sigma, ListTree } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import * as api from '../api.js';
import { VirtualResultGrid } from '../grid/VirtualResultGrid.js';
import { DocumentEditor } from './DocumentEditor.js';
import type { DbQueryResult } from '../types.js';

const PAGE_SIZES = [50, 100, 200];

type Doc = Record<string, unknown>;

export function DocumentsTab({ connKey, database, collection }: { connKey: string; database?: string; collection: string }) {
  const { t } = useTranslation('dbClient');
  const [filter, setFilter] = useState('{}');
  const [appliedFilter, setAppliedFilter] = useState('{}');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = closed; { doc: null } = new document; { doc } = edit existing.
  const [editing, setEditing] = useState<{ doc: Doc | null } | null>(null);
  const [aggOpen, setAggOpen] = useState(false);
  const [pipeline, setPipeline] = useState('[\n  { "$match": {} }\n]');
  const [aggResult, setAggResult] = useState<DbQueryResult | null>(null);
  const [aggErr, setAggErr] = useState<string | null>(null);
  const [aggRunning, setAggRunning] = useState(false);
  const reqRef = useRef(0);

  const runAggregate = useCallback(async () => {
    let pipe: unknown;
    try {
      pipe = JSON.parse(pipeline);
      if (!Array.isArray(pipe)) throw new Error('pipeline must be an array');
    } catch (e) {
      setAggErr(e instanceof Error ? e.message : t('docs.badJson'));
      setAggResult(null);
      return;
    }
    setAggRunning(true);
    setAggErr(null);
    try {
      const res = await api.runCommand(connKey, { kind: 'document', op: 'aggregate', collection, payload: { database, pipeline: pipe } }, 1000);
      setAggResult(res);
    } catch (e) {
      setAggErr(e instanceof Error ? e.message : String(e));
      setAggResult(null);
    } finally {
      setAggRunning(false);
    }
  }, [pipeline, connKey, database, collection, t]);

  const showIndexes = useCallback(async () => {
    setAggOpen(true);
    setAggRunning(true);
    setAggErr(null);
    try {
      const res = await api.runCommand(connKey, { kind: 'document', op: 'listIndexes', collection, payload: { database } });
      setAggResult(res);
    } catch (e) {
      setAggErr(e instanceof Error ? e.message : String(e));
      setAggResult(null);
    } finally {
      setAggRunning(false);
    }
  }, [connKey, database, collection]);

  const load = useCallback(async () => {
    let flt: Doc;
    try {
      flt = appliedFilter.trim() ? (JSON.parse(appliedFilter) as Doc) : {};
    } catch {
      setError(t('docs.badFilter'));
      setResult(null);
      return;
    }
    const my = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.runCommand(
        connKey,
        { kind: 'document', op: 'find', collection, payload: { database, filter: flt, skip: page * pageSize } },
        pageSize,
      );
      if (my === reqRef.current) setResult(res);
    } catch (e) {
      if (my === reqRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
      }
    } finally {
      if (my === reqRef.current) setLoading(false);
    }
  }, [connKey, database, collection, appliedFilter, page, pageSize, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFilter = useCallback(() => {
    setAppliedFilter(filter);
    setPage(0);
  }, [filter]);

  const saveDoc = useCallback(
    async (text: string) => {
      let doc: Doc;
      try {
        doc = JSON.parse(text) as Doc;
      } catch {
        toast.error(t('docs.badJson'));
        return;
      }
      try {
        if (editing?.doc) {
          const id = (editing.doc as { _id?: unknown })._id;
          const { _id: _drop, ...rest } = doc; // _id is immutable — never $set it
          void _drop;
          if (Object.keys(rest).length === 0) {
            toast.warning(t('docs.noChanges'));
            return;
          }
          const res = await api.runCommand(connKey, { kind: 'document', op: 'updateOne', collection, payload: { database, filter: { _id: id }, update: rest } });
          // matchedCount === 0 → the filter hit nothing (e.g. an _id type mismatch).
          if (res.rowCount === 0) {
            toast.warning(t('docs.noMatch'));
            setEditing(null);
            await load();
            return;
          }
        } else {
          await api.runCommand(connKey, { kind: 'document', op: 'insertOne', collection, payload: { database, document: doc } });
        }
        toast.success(t('docs.saved'));
        setEditing(null);
        await load();
      } catch (e) {
        toast.error(t('docs.saveError'), { description: e instanceof Error ? e.message : String(e) });
      }
    },
    [editing, connKey, database, collection, load, t],
  );

  const deleteDoc = useCallback(async () => {
    const id = editing?.doc ? (editing.doc as { _id?: unknown })._id : undefined;
    if (id === undefined) return;
    const res = await api.runCommand(connKey, { kind: 'document', op: 'deleteOne', collection, payload: { database, filter: { _id: id } } });
    if (res.rowCount === 0) toast.warning(t('docs.noMatch'));
    else toast.success(t('docs.deleted'));
    setEditing(null);
    await load();
  }, [editing, connKey, database, collection, load, t]);

  const atLast = result != null && result.rows.length < pageSize;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-1.5">
        <input
          className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs outline-none"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyFilter()}
          placeholder={t('docs.filterPlaceholder')}
          spellCheck={false}
        />
        <Button size="sm" onClick={applyFilter} disabled={loading}>
          <Play className="mr-1.5 h-3 w-3" />
          {t('docs.find')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEditing({ doc: null })}>
          <Plus className="mr-1.5 h-3 w-3" />
          {t('docs.add')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void showIndexes()} title={t('docs.indexes')}>
          <ListTree className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant={aggOpen ? 'secondary' : 'ghost'} onClick={() => setAggOpen((o) => !o)} title={t('docs.aggregate')}>
          <Sigma className="h-3.5 w-3.5" />
        </Button>
      </div>

      {aggOpen && (
        <div className="flex flex-col gap-1 border-b bg-muted/30 p-1.5">
          <div className="flex items-start gap-2">
            <textarea
              className="h-24 flex-1 resize-none rounded border bg-background p-2 font-mono text-xs outline-none"
              value={pipeline}
              onChange={(e) => setPipeline(e.target.value)}
              placeholder={t('docs.pipelinePlaceholder')}
              spellCheck={false}
            />
            <Button size="sm" onClick={() => void runAggregate()} disabled={aggRunning}>
              {aggRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            </Button>
          </div>
          {(aggResult || aggErr) && (
            <div className="h-40 min-h-0">
              <VirtualResultGrid result={aggResult} error={aggErr} tableName={collection} />
            </div>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute right-2 top-2 z-30">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        <VirtualResultGrid result={result} error={error} tableName={collection} onRowOpen={(row) => setEditing({ doc: row })} />
      </div>

      <div className="flex items-center gap-2 border-t px-2 py-1 text-xs">
        <button className="rounded p-1 hover:bg-muted" title={t('data.reload')} onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        <button className="rounded p-1 hover:bg-muted disabled:opacity-40" title={t('data.prev')} disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="tabular-nums text-muted-foreground">{t('data.page', { n: page + 1 })}</span>
        <button className="rounded p-1 hover:bg-muted disabled:opacity-40" title={t('data.next')} disabled={atLast || loading} onClick={() => setPage((p) => p + 1)}>
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <select className="h-6 rounded border bg-background px-1" value={pageSize} onChange={(e) => { setPage(0); setPageSize(Number(e.target.value)); }} title={t('data.pageSize')}>
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {editing && (
        <DocumentEditor
          initial={editing.doc ? JSON.stringify(editing.doc, null, 2) : '{\n  \n}'}
          isNew={!editing.doc}
          onSave={saveDoc}
          onDelete={editing.doc ? deleteDoc : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
