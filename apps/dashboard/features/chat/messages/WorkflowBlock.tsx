import { useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Circle, Loader2, Network, MinusCircle } from 'lucide-react';
import type { Usage, WorkflowRunState, WorkflowStepView } from '../../../hooks/useAgentStream.js';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from './Markdown.js';

interface WorkflowBlockProps {
  run: WorkflowRunState;
  defaultOpen?: boolean;
}

/**
 * Live card for the `workflow` tool (Ultra) — DAG of subagent steps grouped
 * by wave, with per-step status, live tool-budget counters, and expandable
 * result digests. Mirrors TaskExecutionBlock's visual language.
 */
export function WorkflowBlock({ run, defaultOpen }: WorkflowBlockProps) {
  const [open, setOpen] = useState(defaultOpen ?? run.status === 'running');
  const isRunning = run.status === 'running';
  const completed = run.steps.filter((s) => s.status === 'completed' || s.status === 'partial').length;
  const failed = run.steps.filter((s) => s.status === 'failed').length;
  const skipped = run.steps.filter((s) => s.status === 'skipped').length;
  const totalTools = run.steps.reduce((sum, s) => sum + (s.toolCallCount ?? 0), 0);
  const totalTokens = usageTokens(run.totalUsage);

  const stepsByWave = useMemo(() => {
    const groups = new Map<number, WorkflowStepView[]>();
    for (const step of run.steps) {
      const list = groups.get(step.wave) ?? [];
      list.push(step);
      groups.set(step.wave, list);
    }
    return Array.from(groups, ([wave, steps]) => ({ wave, steps }))
      .sort((a, b) => a.wave - b.wave);
  }, [run.steps]);

  return (
    <div className="my-2 rounded-lg border border-violet-500/30 bg-violet-500/[0.04] overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-muted/60 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <div
          className={cn(
            'h-5 w-5 rounded-md flex items-center justify-center shrink-0',
            run.status === 'failed' || run.status === 'aborted'
              ? 'text-destructive bg-destructive/10'
              : isRunning
                ? 'text-warning bg-warning/10'
                : 'text-success bg-success/10',
          )}
        >
          {run.status === 'failed' || run.status === 'aborted' ? (
            <AlertCircle className="h-3 w-3" />
          ) : isRunning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
        </div>
        <Network className="h-3.5 w-3.5 text-violet-400 shrink-0" />
        <span className="font-medium text-foreground truncate">{run.name}</span>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {completed}/{run.steps.length}
        </Badge>
        {failed > 0 && (
          <Badge variant="destructive" className="shrink-0 tabular-nums">
            {failed} failed
          </Badge>
        )}
        {skipped > 0 && (
          <Badge variant="secondary" className="shrink-0 tabular-nums">
            {skipped} skipped
          </Badge>
        )}
        {run.resumed && (
          <Badge variant="secondary" className="shrink-0">resumed</Badge>
        )}
        <Badge className="shrink-0 border-violet-500/40 bg-violet-500/15 text-violet-300" variant="outline">
          Ultra
        </Badge>
        <span className="ml-auto text-muted-foreground tabular-nums shrink-0">
          {run.totalWaves} wave{run.totalWaves === 1 ? '' : 's'} · {totalTools} tool{totalTools === 1 ? '' : 's'}
          {totalTokens > 0 ? ` · ${formatTokens(totalTokens)} tok` : ''}
        </span>
      </button>

      {open && (
        <div className="border-t bg-background/40">
          {stepsByWave.map(({ wave, steps }) => (
            <div key={wave} className="border-b last:border-b-0">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/20">
                Wave {wave}
              </div>
              {steps.map((step) => (
                <WorkflowStepRow key={step.id} step={step} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowStepRow({ step }: { step: WorkflowStepView }) {
  const [open, setOpen] = useState(false);
  const hasDetails = !!step.summary || !!step.error;
  const StatusIcon = step.status === 'running'
    ? Loader2
    : step.status === 'completed' || step.status === 'partial'
      ? Check
      : step.status === 'failed'
        ? AlertCircle
        : step.status === 'skipped'
          ? MinusCircle
          : Circle;
  const statusColor =
    step.status === 'failed'
      ? 'text-destructive bg-destructive/10'
      : step.status === 'running'
        ? 'text-warning bg-warning/10'
        : step.status === 'completed' || step.status === 'partial'
          ? 'text-success bg-success/10'
          : 'text-muted-foreground bg-muted';
  const nearBudget = step.maxToolCalls != null
    && step.maxToolCalls > 0
    && (step.toolCallCount ?? 0) >= Math.ceil(step.maxToolCalls * 0.8);

  return (
    <div className="border-t first:border-t-0">
      <button
        type="button"
        onClick={hasDetails ? () => setOpen((value) => !value) : undefined}
        className={cn(
          'w-full px-3 py-2 flex items-center gap-2 text-left transition-colors',
          hasDetails && 'hover:bg-muted/50 cursor-pointer',
          !hasDetails && 'cursor-default',
        )}
      >
        {hasDetails ? (
          <ChevronRight
            className={cn('h-3 w-3 text-muted-foreground transition-transform shrink-0', open && 'rotate-90')}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <div className={cn('h-4 w-4 rounded flex items-center justify-center shrink-0', statusColor)}>
          <StatusIcon className={cn('h-2.5 w-2.5', step.status === 'running' && 'animate-spin')} />
        </div>
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">{step.id}</span>
        <span className="text-foreground truncate">{step.title}</span>
        <Badge variant="outline" className="text-[10px] shrink-0">
          {step.profile}
        </Badge>
        {step.dependsOn.length > 0 && (
          <span className="text-[10px] text-muted-foreground font-mono shrink-0" title={`depends on ${step.dependsOn.join(', ')}`}>
            ← {step.dependsOn.join(', ')}
          </span>
        )}
        <span
          className={cn(
            'ml-auto tabular-nums shrink-0 text-[10px]',
            nearBudget ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {step.toolCallCount ?? 0}
          {step.maxToolCalls != null && step.maxToolCalls > 0 ? `/${step.maxToolCalls}` : ''} tool
          {(step.toolCallCount ?? 0) === 1 ? '' : 's'}
          {usageTokens(step.usage) > 0 ? ` · ${formatTokens(usageTokens(step.usage))}` : ''}
        </span>
      </button>
      {step.status === 'running' && (step.lastToolName || step.phase) && (
        <div className="px-8 pb-2 text-[11px] text-warning flex flex-wrap gap-x-2">
          {step.phase && <span className="font-mono">{step.phase}</span>}
          {step.lastToolName && <span className="font-mono">last {step.lastToolName}</span>}
        </div>
      )}
      {open && hasDetails && (
        <div className="px-8 pb-3 pt-1 bg-background/50">
          {step.error ? (
            <pre className="font-mono text-[11px] text-destructive whitespace-pre-wrap break-words">
              {step.error}
            </pre>
          ) : (
            <div className="text-[11px] text-foreground/80">
              <Markdown text={step.summary ?? ''} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Reload parser lives in workflow-result-parser.ts (LOC discipline) and is
// re-exported here so callers keep one import site per feature.
export { parseWorkflowResult } from './workflow-result-parser.js';

function usageTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
