import type { StreamTask, StreamTaskExecutionMode } from '../../../hooks/useAgentStream.js';
import { cn } from '../../../lib/utils.js';

interface TaskRowProps {
  task: StreamTask;
  isExpanded: boolean;
  onToggle: () => void;
  executionMode: StreamTaskExecutionMode;
  resolved: 'approved' | 'rejected' | undefined;
  perTaskMode: 'inline' | 'subagent' | undefined;
  onPerTaskModeChange: (mode: 'inline' | 'subagent') => void;
}

const STATUS_BADGE: Record<StreamTask['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-warning/15 text-warning',
  done: 'bg-success/15 text-success',
  failed: 'bg-destructive/15 text-destructive',
  skipped: 'bg-muted text-muted-foreground',
  interrupted: 'bg-orange-500/15 text-orange-600',
};

export function TaskRow({
  task,
  isExpanded,
  onToggle,
  executionMode,
  resolved,
  perTaskMode,
  onPerTaskModeChange,
}: TaskRowProps) {
  const statusBadgeClass = STATUS_BADGE[task.status] ?? 'bg-muted text-muted-foreground';
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors mt-0.5"
          title={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? '▾' : '▸'}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground">{task.id}</span>
            <span className="text-sm font-medium truncate">{task.title}</span>
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded uppercase font-semibold',
                statusBadgeClass,
              )}
            >
              {task.status}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
              {task.estimated_complexity}
            </span>
            {executionMode === 'per-task' && !resolved ? (
              <select
                value={perTaskMode ?? task.suggested_mode}
                onChange={(e) => onPerTaskModeChange(e.target.value as 'inline' | 'subagent')}
                className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-foreground border border-border cursor-pointer"
              >
                <option value="inline">inline</option>
                <option value="subagent">subagent</option>
              </select>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {task.mode_used ?? task.suggested_mode}
              </span>
            )}
            {task.depends_on.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                after: {task.depends_on.join(', ')}
              </span>
            )}
          </div>
          {isExpanded && (
            <div className="mt-2 space-y-2">
              <div className="text-xs text-foreground/80 whitespace-pre-wrap">{task.description}</div>
              {task.files.length > 0 && (
                <div className="text-[11px]">
                  <span className="text-muted-foreground">files:</span>{' '}
                  <span className="font-mono">{task.files.join(', ')}</span>
                </div>
              )}
              {task.references && task.references.length > 0 && (
                <div className="text-[11px]">
                  <span className="text-muted-foreground">refs:</span>{' '}
                  <span className="font-mono">
                    {task.references.map((r) => {
                      let label = `${r.type}:${r.value}`;
                      if (r.file) label += ` [${r.file}${r.lines ? `:${r.lines}` : ''}]`;
                      return label;
                    }).join(', ')}
                  </span>
                </div>
              )}
              {task.result && (
                <div className="text-[11px] border-l-2 border-success/60 pl-2">
                  <div className="text-muted-foreground">result:</div>
                  <div className="text-foreground/80">{task.result.summary}</div>
                  {task.result.files_modified.length > 0 && (
                    <div className="font-mono text-muted-foreground mt-0.5">
                      modified: {task.result.files_modified.join(', ')}
                    </div>
                  )}
                  {task.result.errors && (
                    <div className="text-destructive mt-0.5">{task.result.errors}</div>
                  )}
                  {task.result.sandbox_violations && task.result.sandbox_violations.length > 0 && (
                    <div className="text-warning mt-0.5">
                      sandbox warnings: {task.result.sandbox_violations.join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
