import { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BoardAttachment } from '@mcp/company-contracts';
import { classifyAttachment } from '@mcp/shared/attachments/policy.js';
import { apiBaseUrl } from '../../lib/api-client.js';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog.js';
import { ImageGallery } from '../chat/messages/ImageGallery.js';

export function BoardAttachments({ sessionId, entryId, attachments }: { sessionId: string; entryId: string; attachments: BoardAttachment[] }) {
  const { t } = useTranslation('agents');
  const [selected, setSelected] = useState<number | null>(null);
  const url = (index: number) => `${apiBaseUrl()}/api/company/sessions/${encodeURIComponent(sessionId)}/board/${encodeURIComponent(entryId)}/attachments/${index}`;
  const isImage = (attachment: BoardAttachment) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mediaType);
  const images = attachments.flatMap((attachment, index) => isImage(attachment)
    ? [{ name: attachment.name, src: `${url(index)}?preview=1`, thumbnail: `${url(index)}?thumbnail=1`, download: url(index) }] : []);
  return <div className="mt-3 space-y-2" aria-label={t('board.attachments', 'Attachments')}>
    {images.length > 0 && <ImageGallery images={images} />}
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment, index) => !isImage(attachment) && <div key={`${attachment.sha256}-${index}`} className="flex max-w-sm items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          {classifyAttachment(attachment.name, attachment.mediaType) === 'text'
            ? <button type="button" className="block max-w-60 truncate text-left text-primary hover:underline" onClick={() => setSelected(index)} title={attachment.name}>{attachment.name}</button>
            : <span className="block max-w-60 truncate" title={attachment.name}>{attachment.name}</span>}
          <p className="mt-0.5 text-[10px] text-muted-foreground">{attachment.mediaType} · {Math.max(1, Math.ceil(attachment.size / 1024))} KB</p>
        </div>
        <a href={url(index)} download={attachment.name} aria-label={t('board.downloadAttachment', { name: attachment.name, defaultValue: 'Download {{name}}' })} className="rounded p-1.5 hover:bg-muted"><Download className="size-4" /></a>
      </div>)}
    </div>
    <Dialog open={selected != null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogTitle className="truncate pr-6 text-sm">{selected == null ? '' : attachments[selected]?.name}</DialogTitle>
        {selected != null && <AttachmentText key={url(selected)} url={`${url(selected)}?text=1`} />}
      </DialogContent>
    </Dialog>
  </div>;
}

function AttachmentText({ url }: { url: string }) {
  const { t } = useTranslation('agents');
  const [result, setResult] = useState<{ text?: string; truncated?: boolean; error?: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void fetch(url, { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { text: string; truncated: boolean };
      if (!abort.signal.aborted) setResult(body);
    }).catch((error: Error) => { if (!abort.signal.aborted) setResult({ error: error.message }); });
    return () => abort.abort();
  }, [url]);
  if (!result) return <p role="status" className="text-xs text-muted-foreground">{t('board.loadingAttachment', 'Loading attachment…')}</p>;
  if (result.error) return <p role="alert" className="text-xs text-destructive">{result.error}</p>;
  return <>{result.truncated && <p className="text-xs text-muted-foreground">{t('board.attachmentTruncated', 'Partial preview. Download to read the complete file.')}</p>}<pre className="min-h-0 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-3 text-xs">{result.text}</pre></>;
}
