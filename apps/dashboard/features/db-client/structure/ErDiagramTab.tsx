/** ER diagram with explicit table selection and bounded-concurrency metadata loading. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { DrawioFrame } from '../../chat/right-panel/diagram/DrawioFrame.js';
import * as api from '../api.js';
import { buildErXml } from './er-diagram.js';
import type { DbTableInfo, DbTableRef } from '../types.js';

const AUTO_TABLES = 80;
const DESCRIBE_CONCURRENCY = 6;

async function describeSelected(connKey: string, refs: DbTableRef[]): Promise<DbTableInfo[]> {
  const output = new Array<DbTableInfo>(refs.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(DESCRIBE_CONCURRENCY, refs.length) }, async () => {
    while (cursor < refs.length) {
      const index = cursor++;
      const ref = refs[index];
      output[index] = await api.describeTable(connKey, ref.schema, ref.name);
    }
  }));
  return output;
}

export function ErDiagramTab({ connKey, schema }: { connKey: string; schema?: string }) {
  const { t } = useTranslation('dbClient');
  const [tables, setTables] = useState<DbTableRef[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [xml, setXml] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);

  const build = useCallback(async (refs: DbTableRef[]) => {
    setBuilding(true);
    try {
      setXml(buildErXml(await describeSelected(connKey, refs)));
    } catch {
      setXml(buildErXml([]));
    } finally {
      setBuilding(false);
    }
  }, [connKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.introspect(connKey, undefined, schema).then(({ tables: refs }) => {
      if (cancelled) return;
      setTables(refs);
      const initial = refs.slice(0, AUTO_TABLES);
      setSelected(new Set(initial.map((ref) => `${ref.schema}.${ref.name}`)));
      return build(initial);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [build, connKey, schema]);

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query ? tables.filter((table) => table.name.toLocaleLowerCase().includes(query)) : tables;
  }, [filter, tables]);
  const chosen = useMemo(() => tables.filter((table) => selected.has(`${table.schema}.${table.name}`)), [selected, tables]);

  const toggle = (ref: DbTableRef) => setSelected((current) => {
    const next = new Set(current);
    const key = `${ref.schema}.${ref.name}`;
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (loading && !xml) {
    return <div className="grid h-full place-items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('er.building')}</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <details className="border-b bg-card/70 text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5">
          <span>{t('er.selected', { selected: selected.size, total: tables.length })}</span>
          {tables.length > AUTO_TABLES && selected.size === AUTO_TABLES && <span className="text-amber-500">{t('er.autoSelected', { n: AUTO_TABLES })}</span>}
          <div className="flex-1" />
          <Button size="sm" onClick={(event) => { event.preventDefault(); void build(chosen); }} disabled={building || chosen.length === 0}>
            {building ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}{t('er.rebuild')}
          </Button>
        </summary>
        <div className="border-t p-2">
          <div className="mb-2 flex gap-2">
            <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('er.search')} className="h-7 text-xs" />
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(tables.map((table) => `${table.schema}.${table.name}`)))}>{t('er.all')}</Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('er.none')}</Button>
          </div>
          <div className="grid max-h-40 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-1 overflow-auto">
            {visible.map((table) => <label key={`${table.schema}.${table.name}`} className="flex items-center gap-1.5 truncate rounded px-1 py-0.5 hover:bg-muted"><input type="checkbox" checked={selected.has(`${table.schema}.${table.name}`)} onChange={() => toggle(table)} /><span className="truncate">{table.name}</span></label>)}
          </div>
        </div>
      </details>
      <div className="relative min-h-0 flex-1">
        {building && xml && <div className="absolute inset-0 z-20 grid place-items-center bg-background/40"><Loader2 className="h-5 w-5 animate-spin" /></div>}
        <DrawioFrame xml={xml ?? buildErXml([])} title={schema} />
      </div>
    </div>
  );
}
