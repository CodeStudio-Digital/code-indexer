/**
 * Table structure editor (DataGrip-style deep column editing). Edit each column
 * (name / type / nullable / default / PK / auto-increment), add or drop columns,
 * or define a brand-new table. A live DDL preview pane shows the exact
 * `CREATE`/`ALTER` SQL (built server-side via `ddl` dryRun) before you apply.
 * Indexes + foreign-key editing land in a follow-up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Undo2, Loader2, Check } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { toast, confirm } from '../../../components/ui/prompt-dialog.js';
import { cn } from '../../../lib/utils.js';
import * as api from '../api.js';
import type { DbAlterAction, DbColumnSpec, DbDdlSpec } from '../types.js';

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

let seq = 0;
function blankColumn(): EditorColumn {
  seq += 1;
  return {
    id: `c:${seq}`,
    name: '',
    type: 'text',
    nullable: true,
    def: '',
    pk: false,
    autoInc: false,
    unsigned: false,
    original: null,
    dropped: false,
  };
}

function toColumnSpec(c: EditorColumn): DbColumnSpec {
  return {
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    default: c.def.trim() ? c.def : null,
    primaryKey: c.pk,
    autoIncrement: c.autoInc,
    unsigned: c.unsigned,
  };
}

/** Diff the edited columns against their baseline into ALTER actions. */
function diffToAlter(cols: EditorColumn[]): DbAlterAction[] {
  const actions: DbAlterAction[] = [];
  for (const c of cols) {
    if (c.original) {
      if (c.dropped) {
        actions.push({ kind: 'dropColumn', name: c.original.name });
        continue;
      }
      if (c.name !== c.original.name) {
        actions.push({ kind: 'renameColumn', from: c.original.name, to: c.name });
      }
      const changed =
        c.type !== c.original.type ||
        c.nullable !== c.original.nullable ||
        (c.def.trim() || null) !== (c.original.def ?? null);
      if (changed) actions.push({ kind: 'modifyColumn', name: c.name, column: toColumnSpec(c) });
    } else if (!c.dropped) {
      actions.push({ kind: 'addColumn', column: toColumnSpec(c) });
    }
  }
  return actions;
}

export function TableStructureEditor({
  connectionId,
  schema,
  table,
  onApplied,
}: {
  connectionId: number;
  schema?: string;
  table?: string;
  onApplied?: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const cid = String(connectionId);
  const isNew = !table;
  const [tableName, setTableName] = useState(table ?? '');
  const [cols, setCols] = useState<EditorColumn[]>(() => (isNew ? [{ ...blankColumn(), name: 'id', type: 'INTEGER', nullable: false, pk: true, autoInc: true }] : []));
  const [loaded, setLoaded] = useState(isNew);
  const [previewSql, setPreviewSql] = useState('');
  const [applying, setApplying] = useState(false);

  // Load baseline columns for an existing table.
  useEffect(() => {
    if (isNew || !table) return;
    let cancelled = false;
    void api
      .describeTable(cid, schema ?? '', table)
      .then((info) => {
        if (cancelled) return;
        setCols(
          info.columns.map((c) => ({
            ...blankColumn(),
            name: c.name,
            type: c.dataType,
            nullable: c.nullable,
            def: c.defaultValue ?? '',
            pk: c.isPrimaryKey,
            autoInc: !!c.isAutoIncrement,
            original: { name: c.name, type: c.dataType, nullable: c.nullable, def: c.defaultValue ?? null, pk: c.isPrimaryKey },
          })),
        );
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
    const actions = diffToAlter(cols);
    if (actions.length === 0) return null;
    return { alter: { schema, table: table ?? '', actions } };
  }, [isNew, cols, tableName, schema, table]);

  // Live DDL preview — debounced server-side dryRun.
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

  const set = useCallback((id: string, patch: Partial<EditorColumn>) => {
    setCols((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeCol = useCallback((id: string) => {
    setCols((prev) => {
      const c = prev.find((x) => x.id === id);
      if (c?.original) return prev.map((x) => (x.id === id ? { ...x, dropped: !x.dropped } : x)); // toggle drop
      return prev.filter((x) => x.id !== id); // brand-new → just remove
    });
  }, []);

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
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        {isNew ? (
          <Input
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            placeholder={t('structure.newTablePlaceholder')}
            className="h-7 w-56 text-xs"
          />
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
          <div className="h-full overflow-auto">
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
                    <td className="border-b border-r p-0">
                      <input className="w-full bg-transparent px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-primary" value={c.name} onChange={(e) => set(c.id, { name: e.target.value })} disabled={c.dropped} />
                    </td>
                    <td className="border-b border-r p-0">
                      <input className="w-full bg-transparent px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-primary" value={c.type} onChange={(e) => set(c.id, { type: e.target.value })} disabled={c.dropped} />
                    </td>
                    <td className="border-b border-r px-2 py-1 text-center">
                      <input type="checkbox" checked={c.nullable} onChange={(e) => set(c.id, { nullable: e.target.checked })} disabled={c.dropped} />
                    </td>
                    <td className="border-b border-r p-0">
                      <input className="w-full bg-transparent px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-primary" value={c.def} onChange={(e) => set(c.id, { def: e.target.value })} disabled={c.dropped} />
                    </td>
                    <td className="border-b border-r px-2 py-1 text-center">
                      <input type="checkbox" checked={c.pk} onChange={(e) => set(c.id, { pk: e.target.checked })} disabled={c.dropped} />
                    </td>
                    <td className="border-b border-r px-2 py-1 text-center">
                      <input type="checkbox" checked={c.autoInc} onChange={(e) => set(c.id, { autoInc: e.target.checked })} disabled={c.dropped} />
                    </td>
                    <td className="border-b px-1 py-1 text-center">
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:text-red-400"
                        title={c.dropped ? t('structure.restore') : t('structure.drop')}
                        onClick={() => removeCol(c.id)}
                      >
                        {c.dropped ? <Undo2 className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              onClick={() => setCols((prev) => [...prev, blankColumn()])}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('structure.addColumn')}
            </button>
          </div>
        </Panel>
        <PanelResizeHandle className="h-px bg-border hover:bg-accent" />
        <Panel defaultSize={35} minSize={15}>
          <div className="flex h-full flex-col">
            <div className="border-b px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('structure.ddlPreview')}
            </div>
            <pre className="flex-1 overflow-auto bg-background p-2 font-mono text-xs whitespace-pre-wrap">{previewSql}</pre>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
