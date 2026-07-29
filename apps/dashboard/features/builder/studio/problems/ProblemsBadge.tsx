import React, { useEffect, useState } from 'react';
import { AlertTriangle, History, Wrench, X } from 'lucide-react';
import { formatProblem, requestStudioSend } from '../studio-context-store.js';
import type { Problem } from './usePreviewProblems.js';
import type { AutoFixMode } from './useAutoFix.js';
import {
  getAutoFixHistory,
  recordAutoFix,
  subscribeAutoFixHistory,
  type AutoFixHistoryEntry,
} from './autofix-history.js';

interface ProblemsBadgeProps {
  projectId: number;
  problems: Problem[];
  errorCount: number;
  onDismiss: (id: string) => void;
  onClear: () => void;
  autoFixEnabled: boolean;
  onToggleAutoFix: () => void;
  autoFixMode: AutoFixMode;
  onSetAutoFixMode: (mode: AutoFixMode) => void;
}

/**
 * Toolbar badge + popover listing live runtime/network problems captured
 * from the preview. "Fix" sends the error context to the builder agent
 * (which is instructed to self-heal); "Fix all" sends the batch. The
 * auto-fix controls (on/off + auto vs review dispatch) and the history of
 * fixes sent for this project live in the popover header/footer.
 */
export function ProblemsBadge({
  projectId,
  problems,
  errorCount,
  onDismiss,
  onClear,
  autoFixEnabled,
  onToggleAutoFix,
  autoFixMode,
  onSetAutoFixMode,
}: ProblemsBadgeProps) {
  const [open, setOpen] = useState(false);
  const history = useAutoFixHistory(projectId);
  if (problems.length === 0 && history.length === 0) return null;

  function fix(p: Problem) {
    recordAutoFix(projectId, { ts: Date.now(), label: p.label, via: 'manual' });
    requestStudioSend(projectId, `Fix this error:\n\n${formatProblem(p.raw)}`);
    onDismiss(p.id);
  }
  function fixAll() {
    const blocks = problems.map((p) => formatProblem(p.raw)).join('\n\n');
    recordAutoFix(projectId, { ts: Date.now(), label: `Fix all (${problems.length})`, via: 'manual' });
    requestStudioSend(projectId, `Fix these errors:\n\n${blocks}`);
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
              {autoFixEnabled && (
                <select
                  value={autoFixMode}
                  onChange={(e) => onSetAutoFixMode(e.target.value as AutoFixMode)}
                  className="rounded border bg-background px-1 py-0.5 text-[10px]"
                  title="Send fixes immediately, or stage them for your approval"
                >
                  <option value="auto">auto</option>
                  <option value="review">review</option>
                </select>
              )}
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
          {history.length > 0 && (
            <div className="border-t px-2 py-1.5">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <History className="h-3 w-3" /> Fixes sent
              </div>
              <ul className="mt-1 space-y-0.5">
                {[...history].reverse().slice(0, 5).map((h, i) => (
                  <li key={`${h.ts}-${i}`} className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="rounded bg-muted px-1 text-[9px] uppercase">{h.via}</span>
                    <span className="truncate flex-1" title={h.label}>{h.label}</span>
                    <span className="text-[9px] shrink-0">
                      {new Date(h.ts).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Live view of the per-project fix history (module store subscription). */
function useAutoFixHistory(projectId: number): AutoFixHistoryEntry[] {
  const [list, setList] = useState<AutoFixHistoryEntry[]>(() => getAutoFixHistory(projectId));
  useEffect(() => {
    setList(getAutoFixHistory(projectId));
    return subscribeAutoFixHistory(projectId, () => setList([...getAutoFixHistory(projectId)]));
  }, [projectId]);
  return list;
}
