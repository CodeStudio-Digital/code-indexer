import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../components/ui/dialog.js';
import { apiPost, useApi } from '../../../hooks/useApi.js';

interface LegacyPage {
  items: Array<{ id: number; title: string; category: string; excerpt: string; importedMemoryId: number | null }>;
  total: number; imported: number; offset: number; nextOffset: number | null;
}
interface LegacyDetail {
  id: number; title: string; category: string; content: string; tags: string; referenced_files: string[];
  history: Array<{ id: number; version: number; title: string; content: string; tags: string; updated_at: string }>;
}

/** No legacy writes/deletes: inspection and an explicit copy into active memory. */
export function LegacyMemoryNotes({ projectId, onImported }: { projectId: number; onImported: () => void }) {
  const { t } = useTranslation('projects');
  const [offset, setOffset] = useState(0);
  const { data, loading, error, refetch } = useApi<LegacyPage>(`/projects/${projectId}/agent-memory/legacy?offset=${offset}&limit=40`);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const importNotes = async (snapshotIds: number[]) => {
    setBusy(true); setMessage(null); setActionError(null);
    try {
      const result = await apiPost<{ imported: number; existing: number; skipped: number }>(`/projects/${projectId}/agent-memory/legacy/import`, { snapshotIds });
      setMessage(t('memory.legacy.result', result)); refetch(); onImported();
    } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const pending = data?.items.filter(row => row.importedMemoryId == null).map(row => row.id) ?? [];
  return <div className="space-y-2 py-2">
    <p className="text-xs text-muted-foreground">{t('memory.legacy.hint')}</p>
    {(error || actionError) && <p role="alert" className="text-xs text-destructive">{error || actionError}<button type="button" onClick={refetch} className="ml-2 underline">{t('memory.curation.retry')}</button></p>}
    {message && <p role="status" className="text-xs">{message}</p>}
    {loading ? <p className="text-xs">{t('memory.curation.loading')}</p> : !error && data?.total === 0 ? <p className="text-xs text-muted-foreground">{t('memory.legacy.empty')}</p> : null}
    {data && data.total > 0 && <div className="flex items-center gap-2 text-xs">
      <span>{t('memory.legacy.counts', { total: data.total, imported: data.imported })}</span>
      <Button size="sm" variant="outline" disabled={busy || pending.length === 0 || loading} onClick={() => importNotes(pending)}>{t('memory.legacy.importPage', { count: pending.length })}</Button>
    </div>}
    {!loading && !error && data?.items.map(row => <div key={row.id} className="flex items-center gap-2 rounded border p-2">
      <button type="button" className="text-left min-w-0 flex-1" onClick={() => setSelected(row.id)}><p className="text-xs font-medium truncate">{row.title}</p><p className="text-[10px] text-muted-foreground line-clamp-2">{row.category} · {row.excerpt}</p></button>
      {row.importedMemoryId != null ? <span className="text-[10px] text-muted-foreground">{t('memory.legacy.imported')}</span> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => importNotes([row.id])}>{t('memory.legacy.import')}</Button>}
    </div>)}
    {data && data.total > 40 && <div className="flex items-center justify-between">
      <Button size="sm" variant="ghost" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 40))}>{t('memory.curation.previous')}</Button>
      <Button size="sm" variant="ghost" disabled={data.nextOffset == null || loading} onClick={() => data.nextOffset != null && setOffset(data.nextOffset)}>{t('memory.curation.next')}</Button>
    </div>}
    {selected != null && <LegacyNoteDetail projectId={projectId} snapshotId={selected} onClose={() => setSelected(null)} />}
  </div>;
}

function LegacyNoteDetail({ projectId, snapshotId, onClose }: { projectId: number; snapshotId: number; onClose: () => void }) {
  const { t } = useTranslation('projects');
  const { data, loading, error, refetch } = useApi<LegacyDetail>(`/projects/${projectId}/agent-memory/legacy/${snapshotId}`);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
    <DialogHeader><DialogTitle>{data?.title ?? t('memory.legacy.title')}</DialogTitle><DialogDescription>{t('memory.legacy.preserved')}</DialogDescription></DialogHeader>
    {error && <p role="alert" className="text-xs text-destructive">{error}<button type="button" onClick={refetch} className="ml-2 underline">{t('memory.curation.retry')}</button></p>}
    {loading ? <p className="text-xs">{t('memory.curation.loading')}</p> : data && <>
      <p className="text-xs text-muted-foreground">{data.category} · {data.tags}</p>
      <pre className="text-xs whitespace-pre-wrap break-words font-sans">{data.content}</pre>
      {data.referenced_files.length > 0 && <details className="text-xs"><summary>{t('memory.legacy.files')}</summary><ul>{data.referenced_files.map(file => <li key={file}>{file}</li>)}</ul></details>}
      <details className="text-xs"><summary>{t('snapshots.tabs.history')} ({data.history.length})</summary>{data.history.map(version => <details key={version.id} className="border rounded my-2 p-2"><summary>{t('memory.legacy.version', { version: version.version })} · {version.updated_at} · {version.title}</summary><pre className="whitespace-pre-wrap break-words font-sans">{version.content}</pre><p>{version.tags}</p></details>)}</details>
    </>}
  </DialogContent></Dialog>;
}
