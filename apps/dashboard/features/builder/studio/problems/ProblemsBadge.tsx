import React, { useState } from 'react';
import { AlertTriangle, Wrench, X } from 'lucide-react';
import { formatProblem, requestStudioSend } from '../studio-context-store.js';
import type { Problem } from './usePreviewProblems.js';

interface ProblemsBadgeProps {
  sessionId: number;
  problems: Problem[];
  errorCount: number;
  onDismiss: (id: string) => void;
  onClear: () => void;
  autoFixEnabled: boolean;
  onToggleAutoFix: () => void;
}

/**
 * Toolbar badge + popover listing live runtime/network problems captured
 * from the preview. "Fix" sends the error context to the builder agent
 * (which is instructed to self-heal); "Fix all" sends the batch.
 */
export function ProblemsBadge({
  sessionId,
  problems,
  errorCount,
  onDismiss,
  onClear,
  autoFixEnabled,
  onToggleAutoFix,
}: ProblemsBadgeProps) {
  const [open, setOpen] = useState(false);
  if (problems.length === 0) return null;

  function fix(p: Problem) {
    requestStudioSend(sessionId, `Fix this error:\n\n${formatProblem(p.raw)}`);
    onDismiss(p.id);
  }
  function fixAll() {
    const blocks = problems.map((p) => formatProblem(p.raw)).join('\n\n');
    requestStudioSend(sessionId, `Fix these errors:\n\n${blocks}`);
    onClear();
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
          errorCount > 0
            ? 'text-destructive hover:bg-destructive/10'
            : 'text-amber-600 hover:bg-amber-500/10'
        }`}
        title="Preview problems"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {problems.length}
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-30 w-[360px] max-h-[320px] overflow-auto rounded-md border bg-popover shadow-lg text-xs">
          <div className="flex items-center justify-between px-2 py-1.5 border-b sticky top-0 bg-popover">
            <span className="font-medium">{problems.length} problem(s)</span>
            <div className="flex items-center gap-2">
              <label
                className="flex items-center gap-1 cursor-pointer select-none"
                title="Automatically ask the agent to fix new errors"
              >
                <input type="checkbox" checked={autoFixEnabled} onChange={onToggleAutoFix} />
                Auto-fix
              </label>
              <button onClick={fixAll} className="flex items-center gap-1 text-indigo-600 hover:underline">
                <Wrench className="h-3 w-3" /> Fix all
              </button>
              <button onClick={onClear} className="text-muted-foreground hover:text-foreground">
                Clear
              </button>
            </div>
          </div>
          <ul className="divide-y">
            {problems.map((p) => (
              <li key={p.id} className="flex items-start gap-2 px-2 py-1.5">
                <span
                  className={`mt-0.5 h-1.5 w-1.5 rounded-full shrink-0 ${
                    p.kind === 'network'
                      ? 'bg-orange-500'
                      : p.kind === 'console'
                        ? 'bg-amber-500'
                        : 'bg-destructive'
                  }`}
                />
                <span className="flex-1 break-words text-muted-foreground">{p.label}</span>
                <button
                  onClick={() => fix(p)}
                  className="text-indigo-600 hover:underline shrink-0"
                  title="Ask the agent to fix this"
                >
                  Fix
                </button>
                <button
                  onClick={() => onDismiss(p.id)}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
