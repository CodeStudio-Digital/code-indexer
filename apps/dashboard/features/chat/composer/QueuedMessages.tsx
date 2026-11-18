import { useTranslation } from 'react-i18next';
import { AlertCircle, ListEnd, Loader2, Paperclip, Play, RotateCcw, Send, X } from 'lucide-react';
import type { QueuedMessage } from './useMessageQueue.js';

interface Props {
  items: QueuedMessage[];
  paused?: boolean;
  storageError?: string;
  onResume?: () => void;
  onPromote: (id: string) => void;
  onRemove: (id: string) => void;
}

export function QueuedMessages({ items, paused, storageError, onResume, onPromote, onRemove }: Props) {
  const { t } = useTranslation('chat');
  if (!items.length) return null;
  return (
    <section aria-label={t('composer.queue.title')} className="mb-2 rounded-lg border bg-muted/20 text-xs">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-muted-foreground">
        <ListEnd className="h-3.5 w-3.5" />
        <span className="flex-1">{t('composer.queue.title')} ({items.length})</span>
        {paused && <span>{t('composer.queue.paused')}</span>}
        {paused && items.some(item => item.status === 'pending') && onResume && (
          <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted text-foreground"
            onClick={onResume} aria-label={t('composer.queue.resume')}>
            <Play className="h-3 w-3" />{t('composer.queue.resume')}
          </button>
        )}
      </div>
      {storageError && <p role="status" className="px-2.5 pb-1.5 text-amber-500">{t('composer.queue.storageError')}</p>}
      <ol className="max-h-44 overflow-y-auto overscroll-contain divide-y divide-border/60">
        {items.map((item, index) => {
          const sending = item.status === 'sending';
          const accepted = item.status === 'accepted';
          const failed = item.status === 'error';
          const action = failed ? t('composer.queue.retry') : t('composer.queue.sendNow');
          return (
            <li key={item.id} data-queue-status={item.status} className="flex items-start gap-2 px-2.5 py-2">
              <span className="w-4 shrink-0 pt-0.5 text-muted-foreground tabular-nums">
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : failed ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words whitespace-pre-wrap" title={item.text}>{item.text}</p>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{sending ? t('composer.queue.sending') : accepted ? t('composer.queue.accepted') : failed ? t('composer.queue.failed') : item.mode === 'next-turn' ? t('composer.queue.sendNow') : t('composer.queue.parkedEndOfSession')}</span>
                  {!!item.attachments?.length && <span className="inline-flex items-center gap-0.5" title={item.attachments.map(attachment => attachment.name).join(', ')}>
                    <Paperclip className="h-3 w-3" />{item.attachments.length}
                  </span>}
                </div>
                {failed && <p role="alert" className="mt-1 break-words text-[11px] text-destructive">
                  {item.error === 'queue-delivery-unconfirmed' ? t('composer.queue.unconfirmed') : item.error}
                </p>}
              </div>
              <button type="button" disabled={sending || accepted} onClick={() => onPromote(item.id)} title={action} aria-label={action}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
                {failed ? <RotateCcw className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
              </button>
              <button type="button" disabled={sending || accepted} onClick={() => onRemove(item.id)} title={t('composer.remove')} aria-label={t('composer.remove')}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30">
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
