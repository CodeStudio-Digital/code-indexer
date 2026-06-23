import React, { useState } from 'react';
import { ChevronDown, ChevronUp, GitCommitHorizontal } from 'lucide-react';
import { CheckpointCard } from './CheckpointCard.js';
import { useCheckpoints, type BuilderCheckpoint } from './useCheckpoints.js';

interface CheckpointsTimelineProps {
  projectId: number;
}

/**
 * Collapsible horizontal strip under the builder preview: one card per
 * checkpoint (newest first), each restorable with a two-step confirm.
 * Checkpoints are real git commits — the GitWindow shows the same
 * history; this strip adds thumbnails + one-click restore on top.
 */
export function CheckpointsTimeline({ projectId }: CheckpointsTimelineProps) {
  const { checkpoints, restore, viewDiff, busyId, error } = useCheckpoints(projectId);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  if (checkpoints.length === 0) return null;

  function handleRestore(cp: BuilderCheckpoint) {
    if (confirmId !== cp.id) {
      setConfirmId(cp.id);
      // Confirmation window: a second click within 5s proceeds.
      setTimeout(() => setConfirmId((cur) => (cur === cp.id ? null : cur)), 5000);
      return;
    }
    setConfirmId(null);
    void restore(cp.id);
  }

  return (
    <div className="border-t bg-card/40 text-xs">
      <div className="flex items-center gap-2 px-2 py-1">
        <GitCommitHorizontal className="h-3.5 w-3.5 text-indigo-500" />
        <span className="font-medium">Checkpoints</span>
        <span className="text-[10px] text-muted-foreground">{checkpoints.length}</span>
        {confirmId != null && (
          <span className="text-[10px] text-amber-700 dark:text-amber-300">
            Click Restore again to confirm
          </span>
        )}
        {error && (
          <span className="text-[10px] text-destructive truncate" title={error}>
            {error}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="rounded p-0.5 hover:bg-muted"
          aria-label={collapsed ? 'Expand checkpoints' : 'Collapse checkpoints'}
        >
          {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>
      {!collapsed && (
        <div className="flex gap-2 overflow-x-auto px-2 pb-2">
          {checkpoints.map((cp) => (
            <CheckpointCard
              key={cp.id}
              projectId={projectId}
              checkpoint={cp}
              busy={busyId === cp.id}
              onRestore={() => handleRestore(cp)}
              onViewDiff={() => void viewDiff(cp)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
