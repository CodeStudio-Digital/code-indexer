/**
 * Table structure editor (DataGrip-style). Three sub-tabs — Columns, Indexes,
 * Foreign keys — diffed against the introspected baseline into ALTER actions,
 * with a live server-built DDL preview (dryRun) before apply. Columns support
 * add/drop/rename/modify; indexes/FKs support add + drop (existing ones are
 * drop-only — no in-place edit). Create-table mode is columns-only (add indexes
 * /FKs afterwards). SQLite column-modify / FK-add still need a table rebuild
 * (the preview shows that as a comment).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Undo2, Loader2, Check } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { toast, confirm } from '../../../components/ui/prompt-dialog.js';
import { cn } from '../../../lib/utils.js';
import { SubTabs } from '../../api-client/SubTabs.js';
import { commonTypes } from '../engines.js';
import * as api from '../api.js';
import type { DbAlterAction, DbColumnSpec, DbDdlSpec, DbEngine } from '../types.js';

interface EditorColumn {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  def: string;
  pk: boolean;
  autoInc: boolean;
  unsigned: boolean;
  original: { name: string; type: string; nullable: boolean; def: string | null; pk: boolean } | null;
  dropped: boolean;
}
interface EditorIndex {
  id: string;
  name: string;
  columns: string; // comma-separated
  unique: boolean;
  original: { name: string } | null;
  dropped: boolean;
}
interface EditorFk {
  id: string;
  name: string;
  columns: string;
  refTable: string;
  refColumns: string;
  onDelete: string;
  onUpdate: string;
  original: { name: string } | null;
  dropped: boolean;
}

let seq = 0;
const uid = (p: string) => `${p}:${(seq += 1)}`;
const splitCols = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

function blankColumn(): EditorColumn {
  return { id: uid('c'), name: '', type: 'text', nullable: true, def: '', pk: false, autoInc: false, unsigned: false, original: null, dropped: false };
}
function blankIndex(): EditorIndex {
  return { id: uid('i'), name: '', columns: '', unique: false, original: null, dropped: false };
}
function blankFk(): EditorFk {
  return { id: uid('f'), name: '', columns: '', refTable: '', refColumns: '', onDelete: '', onUpdate: '', original: null, dropped: false };
}

function toColumnSpec(c: EditorColumn): DbColumnSpec {
  return { name: c.name, type: c.type, nullable: c.nullable, default: c.def.trim() ? c.def : null, primaryKey: c.pk, autoIncrement: c.autoInc, unsigned: c.unsigned };
}

function diffColumns(cols: EditorColumn[]): DbAlterAction[] {
  const actions: DbAlterAction[] = [];
  for (const c of cols) {
    if (c.original) {
      if (c.dropped) {
        actions.push({ kind: 'dropColumn', name: c.original.name });
        continue;
      }
      if (c.name !== c.original.name) actions.push({ kind: 'renameColumn', from: c.original.name, to: c.name });
      if (c.type !== c.original.type || c.nullable !== c.original.nullable || (c.def.trim() || null) !== (c.original.def ?? null)) {
        actions.push({ kind: 'modifyColumn', name: c.name, column: toColumnSpec(c) });
      }
    } else if (!c.dropped) {
      actions.push({ kind: 'addColumn', column: toColumnSpec(c) });
    }
  }
  return actions;
}
function diffIndexes(idxs: EditorIndex[]): DbAlterAction[] {
  const actions: DbAlterAction[] = [];
  for (const ix of idxs) {
    if (ix.original) {
      if (ix.dropped) actions.push({ kind: 'dropIndex', name: ix.original.name });
    } else if (!ix.dropped && ix.name.trim() && ix.columns.trim()) {
      actions.push({ kind: 'addIndex', index: { name: ix.name.trim(), columns: splitCols(ix.columns), unique: ix.unique } });
    }
  }
  return actions;
}
function diffFks(fks: EditorFk[], schema?: string): DbAlterAction[] {
  const actions: DbAlterAction[] = [];
  for (const fk of fks) {
    if (fk.original) {
      if (fk.dropped) actions.push({ kind: 'dropForeignKey', name: fk.original.name });
    } else if (!fk.dropped && fk.name.trim() && fk.columns.trim() && fk.refTable.trim() && fk.refColumns.trim()) {
      actions.push({
        kind: 'addForeignKey',
        fk: { name: fk.name.trim(), columns: splitCols(fk.columns), refSchema: schema, refTable: fk.refTable.trim(), refColumns: splitCols(fk.refColumns), onDelete: fk.onDelete || undefined, onUpdate: fk.onUpdate || undefined },
      });
    }
  }
  return actions;
}

export function TableStructureEditor({
  connectionId,
  engine,
  schema,
  table,
  onApplied,
}: {
  connectionId: number;
  engine?: DbEngine;
  schema?: string;
  table?: string;
  onApplied?: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const cid = String(connectionId);
  const isNew = !table;
  const [tab, setTab] = useState<'columns' | 'indexes' | 'fks'>('columns');
  const [tableName, setTableName] = useState(table ?? '');
  const [cols, setCols] = useState<EditorColumn[]>(() => (isNew ? [{ ...blankColumn(), name: 'id', type: 'INTEGER', nullable: false, pk: true, autoInc: true }] : []));
  const [idxs, setIdxs] = useState<EditorIndex[]>([]);
  const [fks, setFks] = useState<EditorFk[]>([]);
  const [loaded, setLoaded] = useState(isNew);
  const [previewSql, setPreviewSql] = useState('');
  const [applying, setApplying] = useState(false);
  const typeListId = useMemo(() => `dbtypes-${cid}`, [cid]);

  useEffect(() => {
    if (isNew || !table) return;
    let cancelled = false;
    void api
      .describeTable(cid, schema ?? '', table)
      .then((info) => {
        if (cancelled) return;
        setCols(info.columns.map((c) => ({ ...blankColumn(), name: c.name, type: c.dataType, nullable: c.nullable, def: c.defaultValue ?? '', pk: c.isPrimaryKey, autoInc: !!c.isAutoIncrement, original: { name: c.name, type: c.dataType, nullable: c.nullable, def: c.defaultValue ?? null, pk: c.isPrimaryKey } })));
        setIdxs((info.indexes ?? []).map((ix) => ({ ...blankIndex(), name: ix.name, columns: ix.columns.join(', '), unique: ix.unique, original: { name: ix.name } })));
        setFks((info.foreignKeys ?? []).map((fk) => ({ ...blankFk(), name: fk.name, columns: fk.columns.join(', '), refTable: fk.refTable, refColumns: fk.refColumns.join(', '), onDelete: fk.onDelete ?? '', onUpdate: fk.onUpdate ?? '', original: { name: fk.name } })));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [cid, schema, table, isNew]);

  const buildSpec = useCallback((): DbDdlSpec | null => {
    if (isNew) {
      const columns = cols.filter((c) => !c.dropped && c.name.trim()).map(toColumnSpec);
      if (!tableName.trim() || columns.length === 0) return null;
      return { create: { schema, table: tableName.trim(), columns } };
    }
    const actions = [...diffColumns(cols), ...diffIndexes(idxs), ...diffFks(fks, schema)];
    if (actions.length === 0) return null;
    return { alter: { schema, table: table ?? '', actions } };
  }, [isNew, cols, idxs, fks, tableName, schema, table]);

  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => {
      const spec = buildSpec();
      if (!spec) {
        setPreviewSql('');
        return;
      }
      void api
        .ddl({ connectionId: cid, op: isNew ? 'create' : 'alter', spec, dryRun: true })
        .then((r) => setPreviewSql(r.sql))
        .catch((e) => setPreviewSql(`-- ${e instanceof Error ? e.message : String(e)}`));
    }, 300);
    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
  }, [buildSpec, cid, isNew, loaded]);

  const setCol = useCallback((id: string, patch: Partial<EditorColumn>) => setCols((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))), []);
  const removeCol = useCallback((id: string) => setCols((p) => { const c = p.find((x) => x.id === id); return c?.original ? p.map((x) => (x.id === id ? { ...x, dropped: !x.dropped } : x)) : p.filter((x) => x.id !== id); }), []);
  const setIdx = useCallback((id: string, patch: Partial<EditorIndex>) => setIdxs((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x))), []);
  const removeIdx = useCallback((id: string) => setIdxs((p) => { const x = p.find((y) => y.id === id); return x?.original ? p.map((y) => (y.id === id ? { ...y, dropped: !y.dropped } : y)) : p.filter((y) => y.id !== id); }), []);
  const setFk = useCallback((id: string, patch: Partial<EditorFk>) => setFks((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x))), []);
  const removeFk = useCallback((id: string) => setFks((p) => { const x = p.find((y) => y.id === id); return x?.original ? p.map((y) => (y.id === id ? { ...y, dropped: !y.dropped } : y)) : p.filter((y) => y.id !== id); }), []);

  const apply = useCallback(async () => {
    const spec = buildSpec();
    if (!spec) {
      toast.error(t('structure.noChanges'));
      return;
    }
    if (!(await confirm({ title: t('structure.apply'), description: t('structure.confirmBody'), tone: 'destructive' }))) return;
    setApplying(true);
    try {
      await api.ddl({ connectionId: cid, op: isNew ? 'create' : 'alter', spec });
      toast.success(t('structure.applied'));
      onApplied?.();
    } catch (e) {
      toast.error(t('structure.applyError'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setApplying(false);
    }
  }, [buildSpec, cid, isNew, t, onApplied]);

  const canApply = useMemo(() => buildSpec() !== null, [buildSpec]);

  if (!loaded) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">{t('structure.loading')}</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <datalist id={typeListId}>
        {commonTypes(engine ?? 'sqlite').map((tp) => (
          <option key={tp} value={tp} />
        ))}
      </datalist>

      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        {isNew ? (
          <Input value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder={t('structure.newTablePlaceholder')} className="h-7 w-56 text-xs" />
        ) : (
          <span className="text-xs font-medium">{table}</span>
        )}
        <div className="flex-1" />
        <Button size="sm" onClick={() => void apply()} disabled={!canApply || applying}>
          {applying ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Check className="mr-1.5 h-3 w-3" />}
          {isNew ? t('structure.create') : t('structure.apply')}
        </Button>
      </div>

      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        <Panel defaultSize={65} minSize={30}>
          <div className="flex h-full flex-col">
            {!isNew && (
              <SubTabs
                tabs={[
                  { id: 'columns', label: t('structure.tabColumns'), badge: cols.length },
                  { id: 'indexes', label: t('structure.tabIndexes'), badge: idxs.length },
                  { id: 'fks', label: t('structure.tabFks'), badge: fks.length },
                ]}
                active={tab}
                onChange={setTab}
              />
            )}
            <div className="min-h-0 flex-1 overflow-auto">
              {(isNew || tab === 'columns') && (
                <ColumnsTable cols={cols} typeListId={typeListId} t={t} setCol={setCol} removeCol={removeCol} onAdd={() => setCols((p) => [...p, blankColumn()])} />
              )}
              {!isNew && tab === 'indexes' && (
                <IndexesTable idxs={idxs} t={t} setIdx={setIdx} removeIdx={removeIdx} onAdd={() => setIdxs((p) => [...p, blankIndex()])} />
              )}
              {!isNew && tab === 'fks' && (
                <FksTable fks={fks} t={t} setFk={setFk} removeFk={removeFk} onAdd={() => setFks((p) => [...p, blankFk()])} />
              )}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="h-px bg-border hover:bg-accent" />
        <Panel defaultSize={35} minSize={15}>
          <div className="flex h-full flex-col">
            <div className="border-b px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('structure.ddlPreview')}</div>
            <pre className="flex-1 overflow-auto bg-background p-2 font-mono text-xs whitespace-pre-wrap">{previewSql}</pre>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

type T = (k: string) => string;

const inputCls = 'w-full bg-transparent px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-primary';

function ColumnsTable({ cols, typeListId, t, setCol, removeCol, onAdd }: { cols: EditorColumn[]; typeListId: string; t: T; setCol: (id: string, p: Partial<EditorColumn>) => void; removeCol: (id: string) => void; onAdd: () => void }) {
  return (
    <>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="text-left text-muted-foreground">
            <th className="border-b border-r px-2 py-1">{t('structure.colName')}</th>
            <th className="border-b border-r px-2 py-1">{t('structure.colType')}</th>
            <th className="border-b border-r px-2 py-1 text-center">{t('structure.nullable')}</th>
            <th className="border-b border-r px-2 py-1">{t('structure.default')}</th>
            <th className="border-b border-r px-2 py-1 text-center">{t('structure.pk')}</th>
            <th className="border-b border-r px-2 py-1 text-center">{t('structure.autoInc')}</th>
            <th className="w-8 border-b px-1 py-1" />
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.id} className={cn('hover:bg-muted/30', c.dropped && 'bg-red-500/5 line-through opacity-60', !c.original && 'bg-emerald-500/5')}>
              <td className="border-b border-r p-0"><input className={inputCls} value={c.name} onChange={(e) => setCol(c.id, { name: e.target.value })} disabled={c.dropped} /></td>
              <td className="border-b border-r p-0"><input className={inputCls} list={typeListId} value={c.type} onChange={(e) => setCol(c.id, { type: e.target.value })} disabled={c.dropped} /></td>
              <td className="border-b border-r px-2 py-1 text-center"><input type="checkbox" checked={c.nullable} onChange={(e) => setCol(c.id, { nullable: e.target.checked })} disabled={c.dropped} /></td>
              <td className="border-b border-r p-0"><input className={inputCls} value={c.def} onChange={(e) => setCol(c.id, { def: e.target.value })} disabled={c.dropped} /></td>
              <td className="border-b border-r px-2 py-1 text-center"><input type="checkbox" checked={c.pk} onChange={(e) => setCol(c.id, { pk: e.target.checked })} disabled={c.dropped} /></td>
              <td className="border-b border-r px-2 py-1 text-center"><input type="checkbox" checked={c.autoInc} onChange={(e) => setCol(c.id, { autoInc: e.target.checked })} disabled={c.dropped} /></td>
              <td className="border-b px-1 py-1 text-center"><DropBtn dropped={c.dropped} t={t} onClick={() => removeCol(c.id)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddBtn label={t('structure.addColumn')} onClick={onAdd} />
    </>
  );
}

function IndexesTable({ idxs, t, setIdx, removeIdx, onAdd }: { idxs: EditorIndex[]; t: T; setIdx: (id: string, p: Partial<EditorIndex>) => void; removeIdx: (id: string) => void; onAdd: () => void }) {
  return (
    <>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="text-left text-muted-foreground">
            <th className="border-b border-r px-2 py-1">{t('structure.idxName')}</th>
            <th className="border-b border-r px-2 py-1">{t('structure.idxCols')}</th>
            <th className="border-b border-r px-2 py-1 text-center">{t('structure.unique')}</th>
            <th className="w-8 border-b px-1 py-1" />
          </tr>
        </thead>
        <tbody>
          {idxs.map((ix) => {
            const ro = !!ix.original;
            return (
              <tr key={ix.id} className={cn('hover:bg-muted/30', ix.dropped && 'bg-red-500/5 line-through opacity-60', !ix.original && 'bg-emerald-500/5')} title={ro ? t('structure.existingReadOnly') : undefined}>
                <td className="border-b border-r p-0"><input className={inputCls} value={ix.name} onChange={(e) => setIdx(ix.id, { name: e.target.value })} disabled={ro || ix.dropped} /></td>
                <td className="border-b border-r p-0"><input className={inputCls} value={ix.columns} onChange={(e) => setIdx(ix.id, { columns: e.target.value })} disabled={ro || ix.dropped} /></td>
                <td className="border-b border-r px-2 py-1 text-center"><input type="checkbox" checked={ix.unique} onChange={(e) => setIdx(ix.id, { unique: e.target.checked })} disabled={ro || ix.dropped} /></td>
                <td className="border-b px-1 py-1 text-center"><DropBtn dropped={ix.dropped} t={t} onClick={() => removeIdx(ix.id)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <AddBtn label={t('structure.addIndex')} onClick={onAdd} />
    </>
  );
}

function FksTable({ fks, t, setFk, removeFk, onAdd }: { fks: EditorFk[]; t: T; setFk: (id: string, p: Partial<EditorFk>) => void; removeFk: (id: string) => void; onAdd: () => void }) {
  return (
    <>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="text-left text-muted-foreground">
            <th className="border-b border-r px-2 py-1">{t('structure.fkName')}</th>
            <th className="border-b border-r px-2 py-1">{t('structure.fkCols')}</th>
            <th className="border-b border-r px-2 py-1">{t('structure.fkRefTable')}</th>
            <th className="border-b border-r px-2 py-1">{t('structure.fkRefCols')}</th>
            <th className="border-b border-r px-2 py-1">{t('structure.onDelete')}</th>
            <th className="w-8 border-b px-1 py-1" />
          </tr>
        </thead>
        <tbody>
          {fks.map((fk) => {
            const ro = !!fk.original;
            return (
              <tr key={fk.id} className={cn('hover:bg-muted/30', fk.dropped && 'bg-red-500/5 line-through opacity-60', !fk.original && 'bg-emerald-500/5')} title={ro ? t('structure.existingReadOnly') : undefined}>
                <td className="border-b border-r p-0"><input className={inputCls} value={fk.name} onChange={(e) => setFk(fk.id, { name: e.target.value })} disabled={ro || fk.dropped} /></td>
                <td className="border-b border-r p-0"><input className={inputCls} value={fk.columns} onChange={(e) => setFk(fk.id, { columns: e.target.value })} disabled={ro || fk.dropped} /></td>
                <td className="border-b border-r p-0"><input className={inputCls} value={fk.refTable} onChange={(e) => setFk(fk.id, { refTable: e.target.value })} disabled={ro || fk.dropped} /></td>
                <td className="border-b border-r p-0"><input className={inputCls} value={fk.refColumns} onChange={(e) => setFk(fk.id, { refColumns: e.target.value })} disabled={ro || fk.dropped} /></td>
                <td className="border-b border-r p-0"><input className={inputCls} value={fk.onDelete} onChange={(e) => setFk(fk.id, { onDelete: e.target.value })} disabled={ro || fk.dropped} placeholder={'CASCADE'} /></td>
                <td className="border-b px-1 py-1 text-center"><DropBtn dropped={fk.dropped} t={t} onClick={() => removeFk(fk.id)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <AddBtn label={t('structure.addFk')} onClick={onAdd} />
    </>
  );
}

function DropBtn({ dropped, t, onClick }: { dropped: boolean; t: T; onClick: () => void }) {
  return (
    <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-red-400" title={dropped ? t('structure.restore') : t('structure.drop')} onClick={onClick}>
      {dropped ? <Undo2 className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
    </button>
  );
}

function AddBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground" onClick={onClick}>
      <Plus className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
