import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import * as api from '../api.js';
import { VirtualResultGrid } from '../grid/VirtualResultGrid.js';
import type { DbQueryResult, DbTableInfo, DbWhereCondition } from '../types.js';

interface RelationTarget {
  id: string;
  label: string;
  schema: string;
  table: string;
  where: DbWhereCondition[];
}

function condition(column: string, value: unknown): DbWhereCondition {
  return value == null ? { column, op: 'isnull' } : { column, op: '=', value: typeof value === 'string' ? value : JSON.stringify(value) };
}

export function RelatedRowsDialog({
  open,
  connKey,
  schema,
  tableInfo,
  row,
  onClose,
}: {
  open: boolean;
  connKey: string;
  schema: string;
  tableInfo: DbTableInfo;
  row: Record<string, unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const outgoing = useMemo<RelationTarget[]>(() => (tableInfo.foreignKeys ?? []).map((fk) => ({
    id: `out:${fk.name}`,
    label: `${fk.name} → ${fk.refTable}`,
    schema: fk.refSchema ?? schema,
    table: fk.refTable,
    where: fk.refColumns.map((column, index) => condition(column, row[fk.columns[index]])),
  })), [row, schema, tableInfo.foreignKeys]);
  const [relations, setRelations] = useState<RelationTarget[]>(outgoing);
  const [activeId, setActiveId] = useState(outgoing[0]?.id ?? '');
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRelations(outgoing);
    setActiveId(outgoing[0]?.id ?? '');
    void api.schemaSnapshot(connKey, schema).then((snapshot) => {
      if (cancelled) return;
      const incoming: RelationTarget[] = [];
      for (const source of snapshot.tables) {
        for (const fk of source.foreignKeys ?? []) {
          if (fk.refTable.toLocaleLowerCase() !== tableInfo.name.toLocaleLowerCase()) continue;
          incoming.push({
            id: `in:${source.name}:${fk.name}`,
            label: `${source.name} → ${tableInfo.name} (${fk.name})`,
            schema: source.schema || schema,
            table: source.name,
            where: fk.columns.map((column, index) => condition(column, row[fk.refColumns[index]])),
          });
        }
      }
      const all = [...outgoing, ...incoming];
      setRelations(all);
      setActiveId((current) => current || all[0]?.id || '');
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [connKey, outgoing, row, schema, tableInfo.name]);

  useEffect(() => {
    const relation = relations.find((item) => item.id === activeId);
    if (!relation) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.tableRows(connKey, relation.schema, relation.table, 200, 0, undefined, relation.where)
      .then((next) => { if (!cancelled) setResult(next); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeId, connKey, relations]);

  const active = relations.find((item) => item.id === activeId);
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="flex h-[70vh] max-w-5xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3"><DialogTitle>{t('grid.relatedRows')}</DialogTitle></DialogHeader>
        <div className="flex min-h-0 flex-1">
          <div className="w-64 overflow-auto border-r p-2">
            {relations.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t('grid.noRelations')}</p>}
            {relations.map((relation) => (
              <Button key={relation.id} variant={relation.id === activeId ? 'secondary' : 'ghost'} size="sm" className="mb-1 w-full justify-start truncate" onClick={() => setActiveId(relation.id)}>{relation.label}</Button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            {loading && <Loader2 className="absolute right-3 top-3 z-20 h-4 w-4 animate-spin" />}
            <VirtualResultGrid result={result} error={error} tableName={active?.table} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
