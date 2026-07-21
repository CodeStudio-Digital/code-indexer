import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import * as api from '../api.js';
import { VirtualResultGrid } from '../grid/VirtualResultGrid.js';
import type { DbIncomingForeignKey, DbQueryResult, DbTableInfo, DbWhereCondition } from '../types.js';

interface RelationTarget {
  id: string;
  label: string;
  schema: string;
  table: string;
  where: DbWhereCondition[];
}

function filterValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function condition(column: string, value: unknown): DbWhereCondition {
  return value == null ? { column, op: 'isnull' } : { column, op: '=', value: filterValue(value) };
}

export function outgoingRelationTargets(
  tableInfo: DbTableInfo,
  row: Record<string, unknown>,
  schema: string,
): RelationTarget[] {
  return (tableInfo.foreignKeys ?? []).map((fk) => ({
    id: `out:${tableInfo.schema || schema}:${tableInfo.name}:${fk.name}`,
    label: `${fk.name} → ${fk.refTable}`,
    schema: fk.refSchema ?? schema,
    table: fk.refTable,
    where: fk.refColumns.map((column, index) => condition(column, row[fk.columns[index]])),
  }));
}

export function incomingRelationTargets(
  incoming: DbIncomingForeignKey[],
  row: Record<string, unknown>,
  targetTable: string,
): RelationTarget[] {
  return incoming.map(({ schema, table, foreignKey }) => ({
    id: `in:${schema}:${table}:${foreignKey.name}`,
    label: `${table} → ${targetTable} (${foreignKey.name})`,
    schema,
    table,
    where: foreignKey.columns.map((column, index) => condition(column, row[foreignKey.refColumns[index]])),
  }));
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
  const outgoing = useMemo<RelationTarget[]>(
    () => outgoingRelationTargets(tableInfo, row, schema),
    [row, schema, tableInfo],
  );
  const [relations, setRelations] = useState<RelationTarget[]>(outgoing);
  const [activeId, setActiveId] = useState(outgoing[0]?.id ?? '');
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [relationError, setRelationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRelations(outgoing);
    setActiveId(outgoing[0]?.id ?? '');
    setRelationError(null);
    setDiscovering(true);
    void api.incomingForeignKeys(connKey, schema, tableInfo.name)
      .then((incoming) => {
        if (cancelled) return;
        const all = [...outgoing, ...incomingRelationTargets(incoming, row, tableInfo.name)];
        setRelations(all);
        setActiveId((current) => (all.some((item) => item.id === current) ? current : all[0]?.id ?? ''));
      })
      .catch((reason) => {
        if (!cancelled) setRelationError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });
    return () => { cancelled = true; };
  }, [connKey, outgoing, row, schema, tableInfo.name]);

  const active = useMemo(() => relations.find((item) => item.id === activeId), [activeId, relations]);

  useEffect(() => {
    if (!active) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setResult(null);
    setLoading(true);
    setError(null);
    void api.tableRows(connKey, active.schema, active.table, 200, 0, undefined, active.where)
      .then((next) => { if (!cancelled) setResult(next); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, connKey]);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="flex h-[70vh] max-w-5xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3"><DialogTitle>{t('grid.relatedRows')}</DialogTitle></DialogHeader>
        <div className="flex min-h-0 flex-1">
          <div className="w-64 overflow-auto border-r p-2">
            {discovering && relations.length === 0 && (
              <p className="flex items-center gap-2 p-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('grid.discoveringRelations')}</p>
            )}
            {!discovering && relations.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t('grid.noRelations')}</p>}
            {relationError && <p className="p-2 text-xs text-red-400">{t('grid.relationsError')}: {relationError}</p>}
            {relations.map((relation) => (
              <Button key={relation.id} variant={relation.id === activeId ? 'secondary' : 'ghost'} size="sm" className="mb-1 w-full justify-start truncate" onClick={() => setActiveId(relation.id)}>{relation.label}</Button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            {loading && <Loader2 className="absolute right-3 top-3 z-20 h-4 w-4 animate-spin" />}
            {!active && discovering && <div className="h-full animate-pulse bg-muted/10" />}
            <VirtualResultGrid result={result} error={error} tableName={active?.table} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
