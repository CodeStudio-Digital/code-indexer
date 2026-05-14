import { useTranslation } from 'react-i18next';
import { Network, Loader2, Check, X, Circle, AlertTriangle } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection.js';
import { cn } from '../../../lib/utils.js';
import { Button } from '../../../components/ui/button.js';
import { apiPost } from '../../../hooks/useApi.js';
import type {
  PipelineNodeRuntimeStatus,
  PipelineRuntimeState,
} from '../../../hooks/agent-stream/types.js';

interface PipelineRuntimeSectionProps {
  sessionId: number;
  pipelineRuntime: PipelineRuntimeState;
}

/**
 * Compact runtime overlay for the chat pipeline. Lists each node with a
 * status badge and verdict/outcome for completed validators. Pause /
 * Resume / Abort buttons appear when the execution is in a state that
 * accepts them.
 *
 * For MVP this is a simple list — a mini xyflow visualization can land
 * in a follow-up PR if the user wants edges drawn explicitly.
 */
export function PipelineRuntimeSection({
  sessionId,
  pipelineRuntime,
}: PipelineRuntimeSectionProps) {
  const { t } = useTranslation('chat');
  const r = pipelineRuntime;
  const nodeIds = Object.keys(r.nodes);
  const isRunning = r.status === 'running';
  const isPaused = r.status === 'paused';
  const isTerminal = r.status === 'completed' || r.status === 'failed' || r.status === 'aborted';

  const callExecAction = async (action: 'pause' | 'resume' | 'abort' | 'confirm') => {
    try {
      await apiPost(
        `/coder/sessions/${sessionId}/pipelines/executions/${r.executionId}/${action}`,
        {},
      );
    } catch (err) {
      // best-effort — the SSE stream will report the eventual outcome
      console.warn(`[pipeline] ${action} failed:`, err);
    }
  };

  return (
    <CollapsibleSection
      id="pipeline"
      sessionId={sessionId}
      title={t('pipelineRuntime.title')}
      icon={<Network className={cn('h-3.5 w-3.5', statusColorClass(r.status))} />}
      headerExtra={
        <span
          className={cn(
            'px-1.5 py-0.5 rounded text-[10px] font-medium',
            statusBadgeClass(r.status),
          )}
        >
          {t(`pipelineRuntime.status.${r.status}`)}
        </span>
      }
      defaultOpen
    >
      <div className="px-3 py-2 text-xs space-y-2">
        {r.error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
            {r.error}
          </div>
        )}
        <ul className="space-y-1">
          {nodeIds.map((id) => {
            const n = r.nodes[id];
            return (
              <li
                key={id}
                className={cn(
                  'flex items-start gap-2 px-1.5 py-1 rounded',
                  id === r.currentNodeId && 'bg-info/10',
                )}
              >
                <span className="mt-0.5 shrink-0">{nodeStatusIcon(n.status)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground truncate" title={n.label ?? id}>
                      {n.label ?? id}
                    </span>
                    {n.kind === 'validate' && (
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                        {t('pipelineRuntime.validatorLabel')}
                      </span>
                    )}
                    {n.verdict && (
                      <span className={cn('text-[10px] px-1 rounded', verdictBadgeClass(n.verdict))}>
                        {n.verdict}
                      </span>
                    )}
                    {!n.verdict && n.outcome && n.outcome !== 'linear' && (
                      <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground">
                        {n.outcome}
                      </span>
                    )}
                  </div>
                  {n.outputPreview && (
                    <div
                      className="text-muted-foreground truncate"
                      title={n.outputPreview}
                    >
                      {n.outputPreview}
                    </div>
                  )}
                  {n.error && <div className="text-destructive truncate" title={n.error}>{n.error}</div>}
                </div>
              </li>
            );
          })}
        </ul>
        {!isTerminal && (
          <div className="flex gap-2 pt-1 border-t">
            {isRunning && (
              <Button size="sm" variant="ghost" onClick={() => callExecAction('pause')}>
                {t('pipelineRuntime.pause')}
              </Button>
            )}
            {isPaused && r.awaitingConfirmation && (
              <Button
                size="sm"
                variant="default"
                onClick={() => callExecAction('confirm')}
              >
                {t('pipelineRuntime.approve')}
              </Button>
            )}
            {isPaused && !r.awaitingConfirmation && (
              <Button size="sm" variant="ghost" onClick={() => callExecAction('resume')}>
                {t('pipelineRuntime.resume')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => callExecAction('abort')}>
              {t('pipelineRuntime.abort')}
            </Button>
          </div>
        )}
        {isPaused && r.awaitingConfirmation && (
          <div className="rounded border border-info/40 bg-info/10 p-2 text-info text-[11px]">
            {t('pipelineRuntime.awaitingConfirmation')}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

function nodeStatusIcon(status: PipelineNodeRuntimeStatus) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 text-info animate-spin" />;
    case 'completed':
      return <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
    case 'failed':
      return <X className="h-3.5 w-3.5 text-destructive" />;
    case 'aborted':
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
    case 'pending':
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function statusColorClass(status: PipelineRuntimeState['status']) {
  switch (status) {
    case 'running':
      return 'text-info';
    case 'paused':
      return 'text-amber-500';
    case 'completed':
      return 'text-success';
    case 'failed':
    case 'aborted':
      return 'text-destructive';
  }
}

function statusBadgeClass(status: PipelineRuntimeState['status']) {
  switch (status) {
    case 'running':
      return 'bg-info/15 text-info';
    case 'paused':
      return 'bg-warning/15 text-warning';
    case 'completed':
      return 'bg-success/15 text-success';
    case 'failed':
    case 'aborted':
      return 'bg-destructive/15 text-destructive';
  }
}

function verdictBadgeClass(verdict: 'pass' | 'fail' | 'review') {
  switch (verdict) {
    case 'pass':
      return 'bg-success/15 text-success';
    case 'fail':
      return 'bg-destructive/15 text-destructive';
    case 'review':
      return 'bg-warning/15 text-warning';
  }
}
