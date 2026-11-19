import { useTranslation } from 'react-i18next';
import { ListEnd, Send } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import type { QueueMode } from './useMessageQueue.js';

interface Props { hasInput: boolean; onQueue: (mode: QueueMode) => void; compact?: boolean }

/** Sending steering and parking the next task are distinct, visible actions. */
export function QueueSplitButton({ hasInput, onQueue, compact }: Props) {
  const { t } = useTranslation('chat');
  return (
    <div className="flex items-center gap-1">
      <Button type="button" onClick={() => onQueue('next-turn')} disabled={!hasInput} size="sm"
        className={compact ? 'h-7 px-2' : ''} title={t('composer.queue.sendNowHint')} aria-label={t('composer.queue.sendNow')}>
        <Send className="h-3.5 w-3.5" />{!compact && t('composer.queue.sendNow')}
      </Button>
      <Button type="button" onClick={() => onQueue('end-of-session')} disabled={!hasInput} size="sm" variant="secondary"
        className={compact ? 'h-7 px-2' : ''} title={t('composer.queue.queueHint')} aria-label={t('composer.queue.queue')}>
        <ListEnd className="h-3.5 w-3.5" />{!compact && t('composer.queue.queue')}
      </Button>
    </div>
  );
}
