import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, Loader2, Check, X, Circle, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection.js';
import { cn } from '../../../lib/utils.js';
import { Button } from '../../../components/ui/button.js';
import { useApi, apiPost } from '../../../hooks/useApi.js';
import { usePolling } from '../../../hooks/usePolling.js';
import { PipelineStageOutput } from './pipeline/PipelineStageOutput.js';
import type { PipelineRuntimeState } from '../../../hooks/agent-stream/types.js';
import type { PipelineExecution, PipelineNodeExecution } from '@mcp/company/types.js';

interface PipelineRuntimeSectionProps {
  sessionId: string;
  /** Live SSE state when available; null after a reload/restart with no executor. */
  pipelineRuntime: PipelineRuntimeState | null;
}

type Detail = { execution: PipelineExecution; nodes: PipelineNodeExecution[] };
const ACTIVE = new Set(['running', 'paused']);

/**
 * Single, persistent pipeline view for the chat. DB-driven (polls the
 * execution-detail endpoint, which falls back to the durable store) so the
 * FULL per-stage output survives reload/restart — the live SSE `runtime`
 * is used only for the executionId hint, instant status and the
 * confirmation gate. Replaces the old SSE-preview-only list.
 */
export function PipelineRuntimeSection({ sessionId, pipelineRuntime }: PipelineRuntimeSectionProps) {
  const { t } = useTranslation('chat');
  const hintId = pipelineRuntime?.executionId ?? null;
  // Without a live hint (reload/restart) find the latest execution.
  const listApi = useApi<PipelineExecution[]>(hintId ? '' : `/coder/sessions/${sessionId}/pipelines/executions`);
  const execId = hintId ?? listApi.data?.[0]?.id ?? null;
  const detailApi = useApi<Detail>(execId ? `/coder/sessions/${sessionId}/pipelines/executions/${execId}` : '');
  const refetch = detailApi.refetch;

  const status = pipelineRuntime?.status ?? detailApi.data?.execution.status;
  // ONE timer, only while live (visibility-aware). `immediate:false` — detailApi
  // already fetched on mount; the unstable `refetch` no longer churns the timer
  // because usePolling holds it in a ref. The node-advance refetch below is an
  // event-driven one-shot, NOT a second loop on the same endpoint.
  usePolling(() => refetch(), 2500, {
    enabled: !!status && ACTIVE.has(status),
    immediate: false,
  });
  // Snappier refresh when the live runtime advances a node.
  useEffect(() => {
    refetch();
  }, [pipelineRuntime?.currentNodeId, pipelineRuntime?.status, refetch]);

  if (!execId || !detailApi.data) return null;
  const { execution, nodes } = detailApi.data;
  const execStatus = pipelineRuntime?.status ?? execution.status;
  const awaitingConfirmation = pipelineRuntime?.awaitingConfirmation ?? false;
  const currentNodeId = pipelineRuntime?.currentNodeId ?? execution.current_node_id;
  const isRunning = execStatus === 'running';
  const isPaused = execStatus === 'paused';
  const isTerminal = execStatus === 'completed' || execStatus === 'failed' || execStatus === 'aborted';

  const callExecAction = async (action: 'pause' | 'resume' | 'abort' | 'confirm') => {
    try {
      await apiPost(`/coder/sessions/${sessionId}/pipelines/executions/${execId}/${action}`, {});
      refetch();
    } catch (err) {
      console.warn(`[pipeline] ${action} failed:`, err);
    }
  };

  return (
    <CollapsibleSection
      id="pipeline"
      sessionId={sessionId}
      title={t('pipelineRuntime.title')}
      icon={<Network className={cn('h-3.5 w-3.5', statusColorClass(execStatus))} />}
      headerExtra={
        <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', statusBadgeClass(execStatus))}>
          {t(`pipelineRuntime.status.${execStatus}`)}
        </span>
      }
      defaultOpen
    >
      <div className="py-1 text-xs space-y-1.5">
        {execution.error_message && (
          <div className="mx-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
            {execution.error_message}
          </div>
        )}
        <div className="space-y-1 px-2">
          {nodes.length === 0 && (
            <div className="py-1 text-muted-foreground">
              {t('pipelineRuntime.waiting', { defaultValue: 'Waiting for the first stage…' })}
            </div>
          )}
          {nodes.map((n) => (
            <NodeRow key={n.id} node={n} active={n.node_id === currentNodeId} />
          ))}
        </div>
        {!isTerminal && (
          <div className="flex gap-2 px-2 pt-1 border-t">
            {isRunning && (
              <Button size="sm" variant="ghost" onClick={() => callExecAction('pause')}>
                {t('pipelineRuntime.pause')}
              </Button>
            )}
            {isPaused && awaitingConfirmation && (
              <Button size="sm" variant="default" onClick={() => callExecAction('confirm')}>
                {t('pipelineRuntime.approve')}
              </Button>
            )}
            {isPaused && !awaitingConfirmation && (
              <Button size="sm" variant="ghost" onClick={() => callExecAction('resume')}>
                {t('pipelineRuntime.resume')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => callExecAction('abort')}>
              {t('pipelineRuntime.abort')}
            </Button>
          </div>
        )}
        {isPaused && awaitingConfirmation && (
          <div className="mx-2 rounded border border-info/40 bg-info/10 p-2 text-info text-[11px]">
            {t('pipelineRuntime.awaitingConfirmation')}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

function NodeRow({ node, active }: { node: PipelineNodeExecution; active: boolean }) {
  const [open, setOpen] = useState(false);
  const hasOutput = !!(node.output_text && node.output_text.trim());
  return (
    <div className={cn('rounded border bg-background/50', active && 'ring-1 ring-info/40')}>
      <button
        type="button"
        onClick={() => hasOutput && setOpen((o) => !o)}
        className="flex w-full items-start gap-2 px-1.5 py-1 text-left"
      >
        <span className="mt-0.5 shrink-0">{nodeStatusIcon(node.status)}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground truncate" title={node.node_label}>
              {node.node_label}
            </span>
            {node.outcome_branch && (
              <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground">{node.outcome_branch}</span>
            )}
            {node.attempt > 1 && <span className="text-[9px] text-muted-foreground">#{node.attempt}</span>}
          </div>
          {node.error_message && (
            <div className="text-destructive truncate" title={node.error_message}>{node.error_message}</div>
          )}
        </div>
        {hasOutput && (
          <span className="mt-0.5 shrink-0 text-muted-foreground">
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
        )}
      </button>
      {open && hasOutput && <PipelineStageOutput title={node.node_label} text={node.output_text!} />}
    </div>
  );
}

function nodeStatusIcon(status: string) {
  switch (status) {
    case 'running': return <Loader2 className="h-3.5 w-3.5 text-info animate-spin" />;
    case 'completed': return <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
    case 'failed': return <X className="h-3.5 w-3.5 text-destructive" />;
    case 'aborted':
    case 'skipped': return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
    default: return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function statusColorClass(status: string) {
  switch (status) {
    case 'running': return 'text-info';
    case 'paused': return 'text-amber-500';
    case 'completed': return 'text-success';
    default: return 'text-destructive';
  }
}

function statusBadgeClass(status: string) {
  switch (status) {
    case 'running': return 'bg-info/15 text-info';
    case 'paused': return 'bg-warning/15 text-warning';
    case 'completed': return 'bg-success/15 text-success';
    default: return 'bg-destructive/15 text-destructive';
  }
}
