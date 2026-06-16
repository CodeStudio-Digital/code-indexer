/**
 * Split button shown in place of Send while the agent is streaming. Primary
 * action enqueues the composed message for the NEXT turn (delivered to the
 * live run immediately); the caret menu also offers "end of session". Shared
 * by the full ComposerToolbar and the compact RailComposerBar.
 */
import { useTranslation } from 'react-i18next';
import { ArrowRightToLine, ChevronDown, ListEnd } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../../../components/ui/dropdown-menu.js';
import type { QueueMode } from './useMessageQueue.js';

interface Props {
  hasInput: boolean;
  onQueue: (mode: QueueMode) => void;
  compact?: boolean;
}

export function QueueSplitButton({ hasInput, onQueue, compact }: Props) {
  const { t } = useTranslation('chat');
  const h = compact ? 'h-7' : '';
  return (
    <div className="flex items-center">
      <Button
        type="button"
        onClick={() => onQueue('next-turn')}
        disabled={!hasInput}
        size="sm"
        variant="secondary"
        className={`${h} rounded-r-none`}
      >
        <ArrowRightToLine className="h-3.5 w-3.5" />
        {t('composer.queue.queue', { defaultValue: 'Enfileirar' })}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            disabled={!hasInput}
            size="sm"
            variant="secondary"
            className={`${h} rounded-l-none border-l border-border/40 px-1.5`}
            aria-label={t('composer.queue.more', { defaultValue: 'Opções de fila' })}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onQueue('next-turn')}>
            <ArrowRightToLine className="h-3.5 w-3.5 mr-2" />
            {t('composer.queue.nextTurn', { defaultValue: 'Injetar no próximo turno' })}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onQueue('end-of-session')}>
            <ListEnd className="h-3.5 w-3.5 mr-2" />
            {t('composer.queue.endOfSession', { defaultValue: 'Injetar no fim da sessão' })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
