/**
 * Overflow menu for the session header's secondary actions (reconnect,
 * reestablish master, reset). Tucking the less-frequent controls behind a
 * "⋯" trigger keeps the header to a single row, mirroring the lean
 * ProjectView chrome. The primary Stop action stays inline in the header.
 */
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, RefreshCw, RotateCcw, Wrench } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu.js';

interface SessionActionsMenuProps {
  /** Show a Reconnect item (session running but the SSE stream dropped). */
  canReconnect: boolean;
  onReconnect: () => void;
  /** Phase H — only a master view passes this. */
  onReestablishMaster?: () => void | Promise<void>;
  onReset: () => void;
}

export function SessionActionsMenu({ canReconnect, onReconnect, onReestablishMaster, onReset }: SessionActionsMenuProps) {
  const { t } = useTranslation('agents');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('company.actions.menu', 'Ações da sessão')}
          title={t('company.actions.menu', 'Ações da sessão')}
          className="h-7 w-7 grid place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {canReconnect && (
          <DropdownMenuItem onSelect={onReconnect}>
            <RefreshCw className="h-3.5 w-3.5 mr-2" />
            {t('company.reconnect')}
          </DropdownMenuItem>
        )}
        {onReestablishMaster && (
          <DropdownMenuItem onSelect={() => void onReestablishMaster()}>
            <Wrench className="h-3.5 w-3.5 mr-2" />
            {t('company.actions.reestablishMaster', 'Reestabelecer Master')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onReset}>
          <RotateCcw className="h-3.5 w-3.5 mr-2" />
          {t('company.actions.reset', 'Reset')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
