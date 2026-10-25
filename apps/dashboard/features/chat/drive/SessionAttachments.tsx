import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, File, FolderOpen, RefreshCw } from 'lucide-react';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { Button } from '../../../components/ui/button.js';
import { ImageGallery } from '../messages/ImageGallery.js';

interface Attachment {
  seq: number; index: number; name: string; media_type: string; size: number | null;
  created_at: string; source_path: string | null; downloadable: boolean;
  origin: 'sent' | 'generated' | 'tool';
}
interface AttachmentPage { items: Attachment[]; total: number; next_offset: number | null }
export function SessionAttachments({ sessionId, revision }: { sessionId: string; revision?: string }) {
  const { t } = useTranslation('chat');
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<AttachmentPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const base = `${apiBaseUrl()}/api/coder/sessions/${sessionId}/attachments`;
  useEffect(() => { setOffset(0); setData(null); }, [sessionId, revision]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    fetch(`${base}?offset=${offset}`, { signal: controller.signal })
      .then(async res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<AttachmentPage>; })
      .then(next => { if (!controller.signal.aborted) setData(previous => offset && previous ? { ...next, items: [...previous.items, ...next.items] } : next); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, offset, tick, revision]);
  return <section className="border-b p-3 space-y-2">
    <div className="flex items-center gap-2"><h3 className="text-xs font-medium flex-1">{t('attachments.sent')}{data ? ` (${data.total})` : ''}</h3>
      <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t('drive.refresh')} disabled={loading}
        onClick={() => { setOffset(0); setTick(value => value + 1); }}><RefreshCw className="h-3 w-3" /></Button></div>
    {loading && <p className="text-xs text-muted-foreground">{t('drive.loading')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {data?.total === 0 && <p className="text-xs text-muted-foreground">{t('attachments.empty')}</p>}
    <ul className="space-y-1">{data?.items.map(item => <li key={`${item.seq}:${item.index}`} className="flex items-center gap-2 rounded border p-2">
      {item.downloadable && item.media_type?.startsWith('image/')
        ? <ImageGallery compact images={[{ name: item.name, src: `${base}/${item.seq}/${item.index}?preview=1`, thumbnail: `${base}/${item.seq}/${item.index}?thumbnail=1` }]} />
        : <File className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1"><p className="text-xs truncate" title={item.name}>{item.name}</p>
        <p className="text-[10px] text-muted-foreground">{t(`attachments.origin.${item.origin ?? 'sent'}`)} · {t('attachments.message', { seq: item.seq })} · {item.size == null ? t('attachments.reference') : `${Math.ceil(item.size / 1024)} KB`}</p>
      </div>
      {item.downloadable && <a href={`${base}/${item.seq}/${item.index}`} download={item.name} aria-label={t('attachments.download', { name: item.name })} className="p-1 hover:bg-muted rounded"><Download className="h-3.5 w-3.5" /></a>}
      {item.source_path && window.electronAPI?.showItemInFolder && <button aria-label={t('attachments.locate', { name: item.name })} onClick={() => window.electronAPI?.showItemInFolder?.(item.source_path!)} className="p-1 hover:bg-muted rounded"><FolderOpen className="h-3.5 w-3.5" /></button>}
      {item.source_path && !window.electronAPI?.showItemInFolder && <span className="text-[10px] break-all select-text" title={item.source_path}>{item.source_path}</span>}
    </li>)}</ul>
    {data?.next_offset != null && <Button variant="outline" size="sm" disabled={loading} onClick={() => setOffset(data.next_offset!)}>{t('sessionFiles.more')}</Button>}
  </section>;
}
