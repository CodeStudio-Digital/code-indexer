import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Download, File, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { Button } from '../../../components/ui/button.js';

interface FilePage {
  root_path: string; path: string; parent: string | null; next_offset: number | null;
  entries: Array<{ name: string; path: string; type: 'directory' | 'file' }>;
}
export function SessionFilesTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('chat');
  const [path, setPath] = useState('');
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<FilePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const base = `${apiBaseUrl()}/api/coder/sessions/${sessionId}/files`;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    fetch(`${base}?${new URLSearchParams({ path, offset: String(offset) })}`, { signal: controller.signal })
      .then(async res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<FilePage>; })
      .then(next => { if (!controller.signal.aborted) setData(previous => offset && previous?.path === next.path ? { ...next, entries: [...previous.entries, ...next.entries] } : next); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, path, offset, tick]);
  const navigate = (next: string) => { setPath(next); setOffset(0); setData(null); };
  return <div className="p-3 space-y-3">
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" disabled={!data || !window.electronAPI?.openPath}
        onClick={() => data && window.electronAPI?.openPath(data.root_path)}>
        <FolderOpen className="h-3.5 w-3.5 mr-1" />{t('sessionFiles.openFolder')}
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7 ml-auto" aria-label={t('drive.refresh')}
        disabled={loading} onClick={() => { setOffset(0); setTick(value => value + 1); }}><RefreshCw className="h-3.5 w-3.5" /></Button>
    </div>
    {data && <p className="break-all text-[11px] text-muted-foreground select-text">{data.root_path}</p>}
    <div className="flex items-center gap-2 text-xs">
      <Button variant="ghost" size="icon" className="h-6 w-6" disabled={!path || loading} aria-label={t('sessionFiles.up')}
        onClick={() => navigate(data?.parent ?? '')}><ArrowUp className="h-3 w-3" /></Button>
      <button onClick={() => navigate('')} className="shrink-0 hover:underline">{t('sessionFiles.root')}</button>
      <span className="truncate" title={path}>/ {path}</span>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {loading && <p className="text-xs text-muted-foreground">{t('drive.loading')}</p>}
    {data && !loading && data.entries.length === 0 && <p className="text-xs text-muted-foreground">{t('sessionFiles.empty')}</p>}
    <ul className="space-y-1">
      {data?.entries.map(entry => <li key={entry.path}>
        {entry.type === 'directory' ? <button className="flex items-center gap-2 w-full rounded p-1.5 text-xs text-left hover:bg-muted" onClick={() => navigate(entry.path)}>
          <Folder className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{entry.name}</span>
        </button> : <a className="flex items-center gap-2 rounded p-1.5 text-xs hover:bg-muted" download={entry.name}
          href={`${base}?${new URLSearchParams({ path: entry.path, download: '1' })}`}>
          <File className="h-3.5 w-3.5 shrink-0" /><span className="truncate flex-1" title={entry.name}>{entry.name}</span><Download className="h-3 w-3 shrink-0" />
        </a>}
      </li>)}
    </ul>
    {data?.next_offset != null && <Button variant="outline" size="sm" disabled={loading} onClick={() => setOffset(data.next_offset!)}>{t('sessionFiles.more')}</Button>}
  </div>;
}
