/**
 * Live output for a selected run. Reuses the shared xterm renderer
 * (`SingleTerminal`) bound to the run's `terminalId` — it replays the
 * buffered output on mount, so switching back to a run shows its full
 * scrollback. We never kill the PTY here (stop/restart live in the
 * ActiveList); on process exit we only let the status badge update.
 */

import type { RunnerTask } from '@mcp/api-bus';
import { SingleTerminal } from '../../../shared/terminal/SingleTerminal.js';

interface RunnerOutputProps {
  task: RunnerTask;
}

export function RunnerOutput({ task }: RunnerOutputProps) {
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="shrink-0 px-3 py-1.5 border-b bg-card/40 flex items-center gap-2">
        <span className="text-xs font-medium truncate">{task.label}</span>
        <span className="text-[10px] text-muted-foreground truncate">{task.command}</span>
        <span className="text-[10px] text-muted-foreground/60 shrink-0" aria-hidden="true">·</span>
        <code
          className="text-[10px] text-muted-foreground/80 truncate"
          title={task.cwd ?? '.'}
        >
          {task.cwd ? `./${task.cwd}` : './'}
        </code>
      </div>
      <div className="flex-1 min-h-0 relative">
        <SingleTerminal terminalId={task.terminalId} onProcessExited={() => undefined} />
      </div>
    </div>
  );
}
