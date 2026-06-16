/**
 * Strip of queued follow-up messages, rendered above the composer while the
 * agent runs. Parked ('end-of-session') items wait for the run to finish;
 * 'sent' ('next-turn') items show a transient delivery confirmation. Each
 * parked item can be sent now (promote) or removed.
 */
import { useTranslation } from 'react-i18next';
import { ArrowRightToLine, Check, ListEnd, Send, X } from 'lucide-react';
import type { QueuedMessage } from './useMessageQueue.js';

interface Props {
  items: QueuedMessage[];
  onPromote: (item: QueuedMessage) => void;
  onRemove: (id: number) => void;
}

export function QueuedMessages({ items, onPromote, onRemove }: Props) {
  const { t } = useTranslation('chat');
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 mb-2">
      <div className="px-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {t('composer.queue.title', { defaultValue: 'Na fila' })} ({items.length})
      </div>
      {items.map((it) => {
        const sent = it.status === 'sent';
        const isNext = it.mode === 'next-turn';
        return (
          <div
            key={it.id}
            className={`group flex items-center gap-2 h-7 pl-2 pr-1 rounded-md border text-[11px] ${
              sent
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-border bg-muted/40'
            }`}
          >
            {sent ? (
              <Check className="h-3 w-3 shrink-0" />
            ) : isNext ? (
              <ArrowRightToLine className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ListEnd className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 min-w-0 truncate" title={it.text}>
              {it.text}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {sent
                ? t('composer.queue.sentNextTurn', { defaultValue: '→ próximo turno' })
                : t('composer.queue.parkedEndOfSession', { defaultValue: '→ fim da sessão' })}
            </span>
            {!sent && (
              <button
                type="button"
                onClick={() => onPromote(it)}
                title={t('composer.queue.sendNow', { defaultValue: 'Enviar agora' })}
                className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <Send className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(it.id)}
              title={t('composer.remove')}
              className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
