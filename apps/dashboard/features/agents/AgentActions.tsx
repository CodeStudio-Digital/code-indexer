import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Trash2 } from 'lucide-react';
import type { AgentRunStatus } from '@mcp/company-contracts';
import { cn } from '../../lib/utils.js';

interface AgentActionsProps {
  status: AgentRunStatus;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}

// "Running" = actively working, so Pause is offered. "Resumable" = stopped
// in a way that `reactivate` can continue from, so Resume is offered.
const RUNNING = new Set<AgentRunStatus>(['running', 'working']);
const RESUMABLE = new Set<AgentRunStatus>(['paused', 'aborted', 'error', 'interrupted']);

/**
 * Per-agent control buttons rendered in a subordinate's `AgentPane`
 * header. Pause/Resume are status-gated; Delete is always available.
 * Clicks stop propagation so they don't trigger the card's open-session
 * `onClick`.
 */
export function AgentActions({ status, onPause, onResume, onDelete }: AgentActionsProps) {
  const { t } = useTranslation('agents');
  const stop = (e: MouseEvent) => e.stopPropagation();
  const btn = 'p-0.5 rounded text-muted-foreground transition-colors';

  return (
    <div className="flex items-center gap-0.5 shrink-0" onClick={stop}>
      {RUNNING.has(status) && (
        <button
          type="button"
          title={t('agentActions.pause')}
          className={cn(btn, 'hover:text-yellow-400')}
          onClick={onPause}
        >
          <Pause className="h-3 w-3" />
        </button>
      )}
      {RESUMABLE.has(status) && (
        <button
          type="button"
          title={t('agentActions.resume')}
          className={cn(btn, 'hover:text-green-400')}
          onClick={onResume}
        >
          <Play className="h-3 w-3" />
        </button>
      )}
      <button
        type="button"
        title={t('agentActions.delete')}
        className={cn(btn, 'hover:text-destructive')}
        onClick={onDelete}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
