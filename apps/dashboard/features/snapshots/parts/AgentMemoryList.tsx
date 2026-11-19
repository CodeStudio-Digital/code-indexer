import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, Archive, Undo2, Plus } from 'lucide-react';
import { apiPost, apiPut, useApi } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';
import { Button } from '../../../components/ui/button.js';
import { AgentMemoryForm } from './AgentMemoryForm.js';
import type { CuratedMemory, MemoryPage } from './agent-memory-types.js';
import { archiveReasonKey } from './agent-memory-types.js';

const PAGE_SIZE = 40;
interface ListProps { projectId: number; revision?: number; onChanged?: () => void }
export function AgentMemoryList(props: ListProps) { return <MemoryList key={props.projectId} {...props} />; }
function MemoryList({ projectId, revision = 0, onChanged }: ListProps) {
  const { t } = useTranslation('projects');
  const [offset, setOffset] = useState(0);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const url = `/projects/${projectId}/agent-memory?limit=${PAGE_SIZE}&offset=${offset}&archived=${archived}&q=${encodeURIComponent(search)}`;
  const { data, loading, error, refetch } = useApi<MemoryPage>(url);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: number | null } | null>(null);
  useEffect(() => { if (revision > 0) refetch(); }, [revision, refetch]);
  const changed = () => { refetch(); onChanged?.(); };
  const act = async (id: number, operation: () => Promise<unknown>, removesRow = false) => {
    setBusyId(id); setActionError(null);
    try { await operation(); if (removesRow && offset > 0 && data?.items.length === 1) setOffset(Math.max(0, offset - PAGE_SIZE)); changed(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyId(null); }
  };
  const togglePin = (row: CuratedMemory) => act(row.id, () => apiPut(`/agent-memory/${row.id}/importance`, {
    importance: row.importance >= 0.9 ? 0.5 : 0.95,
  }));
  return (
    <section className="py-3 space-y-3" aria-label={t('memory.curation.title')}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t('memory.curation.title')}</h3>
        <Button size="sm" variant="secondary" className="ml-auto h-7 text-xs" onClick={() => setForm({ id: null })}><Plus className="h-3 w-3" />{t('memory.curation.create')}</Button>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setOffset(0); setSearch(query.trim()); }}>
        <input aria-label={t('memory.curation.search')} placeholder={t('memory.curation.search')} value={query} onChange={event => setQuery(event.target.value)} maxLength={200} className="flex-1 min-w-32 rounded border bg-background px-2 py-1 text-xs" />
        <Button type="submit" size="sm" variant="outline" className="h-7 text-xs">{t('memory.curation.searchButton')}</Button>
        <select aria-label={t('memory.curation.status')} value={archived ? 'archived' : 'live'} onChange={event => { setArchived(event.target.value === 'archived'); setOffset(0); }} className="rounded border bg-background px-2 text-xs">
          <option value="live">{t('memory.curation.live', { count: data?.totals.total ?? 0 })}</option>
          <option value="archived">{t('memory.curation.archived', { count: data?.totals.archived ?? 0 })}</option>
        </select>
      </form>
      {(error || actionError) && <div role="alert" className="text-xs text-destructive">{error || actionError}<button type="button" onClick={refetch} className="ml-2 underline">{t('memory.curation.retry')}</button></div>}
      {loading ? <p className="text-xs text-muted-foreground">{t('memory.curation.loading')}</p> : !error && data?.items.length === 0 ? <p className="text-xs text-muted-foreground">{t(search ? 'memory.curation.noMatch' : 'memory.curation.empty')}</p> : null}
      {!loading && !error && data?.items.map(row => (
        <div key={row.id} className={cn('flex items-start gap-2 rounded-md border bg-background/30 p-3 hover:border-primary/40', archived && 'opacity-80')}>
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setForm({ id: row.id })}>
            <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[10px]">{t(`memory.category.${row.type}`, row.type)}</span><span className="text-sm font-medium break-words [overflow-wrap:anywhere]">{row.description || row.name}</span></div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{row.excerpt}</p>
            <p className="mt-2 text-[11px] text-muted-foreground" title={t('memory.list.accessTip')}>{t(`memory.source.${row.source}`, row.source)} · {t('memory.curation.retrieved', { count: row.access_count })}</p>
            {row.archived_reason && <p className="mt-1 text-[11px] text-muted-foreground">{t(`memory.archive.${archiveReasonKey(row.archived_reason)}`)}</p>}
          </button>
          {!archived ? <>
            <button type="button" disabled={busyId !== null} onClick={() => togglePin(row)} aria-label={t(row.importance >= 0.9 ? 'memory.list.unpin' : 'memory.list.pin')} className="p-1 rounded hover:bg-muted disabled:opacity-50"><Star className={cn('h-3.5 w-3.5', row.importance >= 0.9 && 'fill-amber-400 text-amber-400')} /></button>
            <button type="button" disabled={busyId !== null} onClick={() => act(row.id, () => apiPost(`/agent-memory/${row.id}/archive`, {}), true)} aria-label={t('memory.list.archive')} className="p-1 rounded hover:bg-muted disabled:opacity-50"><Archive className="h-3.5 w-3.5" /></button>
          </> : <button type="button" disabled={busyId !== null} onClick={() => act(row.id, () => apiPost(`/agent-memory/${row.id}/restore`, {}), true)} aria-label={t('memory.list.restore')} className="p-1 rounded hover:bg-muted disabled:opacity-50"><Undo2 className="h-3.5 w-3.5" /></button>}
        </div>
      ))}
      {data && !error && !loading && <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <Button size="sm" variant="ghost" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t('memory.curation.previous')}</Button>
        <span>{t('memory.curation.page', { from: data.total ? offset + 1 : 0, to: Math.min(offset + data.items.length, data.total), total: data.total })}</span>
        <Button size="sm" variant="ghost" disabled={loading || data.nextOffset == null} onClick={() => data.nextOffset != null && setOffset(data.nextOffset)}>{t('memory.curation.next')}</Button>
      </div>}
      {form && <AgentMemoryForm key={`${projectId}:${form.id ?? 'new'}`} projectId={projectId} memoryId={form.id} onClose={() => setForm(null)} onSaved={changed} onOpenRelated={id => setForm({ id })} />}
    </section>
  );
}
