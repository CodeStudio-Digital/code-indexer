import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.js';
import { confirm, toast } from '../../../components/ui/prompt-dialog.js';
import { cn } from '../../../lib/utils.js';
import * as api from '../api.js';
import type { DbConnection } from '../types.js';
import { diffSchemas, type SchemaMigrationChange } from './schema-diff.js';

function isRelational(connection: DbConnection): boolean {
  return connection.engine !== 'mongodb' && connection.engine !== 'redis';
}

export function SchemaDiffTab({
  projectId,
  sourceConnKey,
  sourceSchema,
}: {
  projectId: number;
  sourceConnKey: string;
  sourceSchema: string;
}) {
  const { t } = useTranslation('dbClient');
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [targetId, setTargetId] = useState('');
  const [targetSchema, setTargetSchema] = useState('');
  const [targetSchemas, setTargetSchemas] = useState<string[]>([]);
  const [changes, setChanges] = useState<SchemaMigrationChange[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState('');
  const [atomic, setAtomic] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.listConnections(projectId).then((rows) => {
      if (cancelled) return;
      const relational = rows.filter(isRelational);
      setConnections(relational);
      const sourceId = sourceConnKey.split('@')[0];
      const initial = relational.find((connection) => String(connection.id) !== sourceId) ?? relational[0];
      if (initial) setTargetId(String(initial.id));
    }).catch((error) => toast.error(t('schemaDiff.loadError'), { description: error instanceof Error ? error.message : String(error) }));
    return () => { cancelled = true; };
  }, [projectId, sourceConnKey, t]);

  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    setTargetSchemas([]);
    setTargetSchema('');
    void api.introspect(targetId).then(({ schemas }) => {
      if (cancelled) return;
      setTargetSchemas(schemas);
      setTargetSchema(schemas.includes(sourceSchema) ? sourceSchema : (schemas[0] ?? sourceSchema));
    }).catch((error) => {
      if (!cancelled) toast.error(t('schemaDiff.loadError'), { description: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [sourceSchema, targetId, t]);

  const chosen = useMemo(() => changes.filter((change) => selected.has(change.id)), [changes, selected]);

  const compare = useCallback(async () => {
    if (!targetId || !targetSchema.trim()) return;
    setLoading(true);
    try {
      const [source, target] = await Promise.all([
        api.schemaSnapshot(sourceConnKey, sourceSchema),
        api.schemaSnapshot(targetId, targetSchema.trim()),
      ]);
      const next = diffSchemas(source, target);
      setChanges(next);
      // Safe additions are selected by default; every destructive action requires
      // an explicit click before it can reach the migration endpoint.
      setSelected(new Set(next.filter((change) => !change.destructive).map((change) => change.id)));
      setPreview('');
      setAtomic(null);
    } catch (error) {
      toast.error(t('schemaDiff.loadError'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [sourceConnKey, sourceSchema, targetId, targetSchema, t]);

  const previewSelected = useCallback(async () => {
    if (!targetId || chosen.length === 0) return;
    setLoading(true);
    try {
      const result = await api.runMigration(targetId, chosen.map(({ op, spec }) => ({ op, spec })), true);
      setPreview(result.sql);
      setAtomic(result.atomic);
    } catch (error) {
      toast.error(t('schemaDiff.previewError'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [chosen, targetId, t]);

  const applySelected = useCallback(async () => {
    if (!targetId || chosen.length === 0) return;
    const destructive = chosen.filter((change) => change.destructive).length;
    if (!(await confirm({
      title: t('schemaDiff.applyTitle'),
      description: destructive > 0
        ? t('schemaDiff.applyDestructive', { count: destructive })
        : t('schemaDiff.applySafe', { count: chosen.length }),
      tone: destructive > 0 ? 'destructive' : 'default',
    }))) return;
    setApplying(true);
    try {
      const result = await api.runMigration(targetId, chosen.map(({ op, spec }) => ({ op, spec })));
      toast.success(t('schemaDiff.applied', { count: result.applied }));
      setAtomic(result.atomic);
      await compare();
      window.dispatchEvent(new CustomEvent('mcp:database-changed', { detail: { connectionId: Number(targetId), schema: targetSchema } }));
    } catch (error) {
      toast.error(t('schemaDiff.applyError'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setApplying(false);
    }
  }, [chosen, compare, targetId, targetSchema, t]);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b p-2">
        <div className="min-w-44">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t('schemaDiff.source')}</div>
          <Input value={`${sourceConnKey} · ${sourceSchema}`} readOnly className="h-8 text-xs" />
        </div>
        <div className="min-w-52">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t('schemaDiff.targetConnection')}</div>
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={t('schemaDiff.chooseConnection')} /></SelectTrigger>
            <SelectContent>{connections.map((connection) => <SelectItem key={connection.id} value={String(connection.id)}>{connection.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="min-w-44">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t('schemaDiff.targetSchema')}</div>
          <Input value={targetSchema} onChange={(event) => setTargetSchema(event.target.value)} list="db-target-schemas" className="h-8 text-xs" />
          <datalist id="db-target-schemas">{targetSchemas.map((schema) => <option key={schema} value={schema} />)}</datalist>
        </div>
        <Button size="sm" onClick={() => void compare()} disabled={!targetId || !targetSchema || loading}>
          {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
          {t('schemaDiff.compare')}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r">
          <div className="flex items-center gap-2 border-b px-2 py-1.5 text-xs">
            <span>{t('schemaDiff.changes', { count: changes.length })}</span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(changes.filter((change) => !change.destructive).map((change) => change.id)))}>{t('schemaDiff.safeOnly')}</Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(changes.map((change) => change.id)))}>{t('schemaDiff.selectAll')}</Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {changes.length === 0 ? (
              <div className="grid h-full place-items-center text-xs text-muted-foreground">{t('schemaDiff.empty')}</div>
            ) : changes.map((change) => (
              <label key={change.id} className={cn('mb-1 flex cursor-pointer items-center gap-2 rounded border px-2 py-2 text-xs hover:bg-muted/50', change.destructive && 'border-amber-500/30 bg-amber-500/5')}>
                <input type="checkbox" checked={selected.has(change.id)} onChange={() => toggle(change.id)} />
                {change.destructive ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" /> : <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
                <span className="min-w-0 flex-1 truncate">{change.label}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{change.kind}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex w-[44%] min-w-72 flex-col">
          <div className="flex items-center gap-2 border-b px-2 py-1.5">
            <span className="text-xs font-medium">{t('schemaDiff.sqlPreview')}</span>
            {atomic != null && <span className={cn('text-[10px]', atomic ? 'text-emerald-500' : 'text-amber-500')}>{atomic ? t('schemaDiff.atomic') : t('schemaDiff.bestEffort')}</span>}
            <div className="flex-1" />
            <Button variant="secondary" size="sm" onClick={() => void previewSelected()} disabled={chosen.length === 0 || loading}>{t('schemaDiff.preview')}</Button>
            <Button size="sm" onClick={() => void applySelected()} disabled={chosen.length === 0 || applying}>
              {applying && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{t('schemaDiff.apply')}
            </Button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] text-foreground">{preview || t('schemaDiff.previewHint')}</pre>
        </div>
      </div>
    </div>
  );
}
