import React, { useState } from 'react';
import { History, ImageOff } from 'lucide-react';
import { thumbnailUrl, type BuilderCheckpoint } from './useCheckpoints.js';
import { parseDbDate } from '../../../lib/datetime.js';

interface CheckpointCardProps {
  projectId: number;
  checkpoint: BuilderCheckpoint;
  busy: boolean;
  onRestore: () => void;
  onViewDiff: () => void;
}

const KIND_BADGE: Record<BuilderCheckpoint['kind'], string> = {
  auto: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
  visual: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  restore: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  manual: 'bg-muted text-muted-foreground',
};

/** One card on the timeline strip: thumbnail (or placeholder) + label + actions. */
export function CheckpointCard({ projectId, checkpoint, busy, onRestore, onViewDiff }: CheckpointCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const url = imgFailed ? null : thumbnailUrl(projectId, checkpoint);
  const time = parseDbDate(checkpoint.created_at);

  return (
    <div className="w-40 shrink-0 rounded-md border bg-card overflow-hidden">
      <div className="h-20 bg-gradient-to-br from-indigo-500/10 to-purple-500/10 grid place-items-center">
        {url ? (
          <img
            src={url}
            alt={checkpoint.label}
            className="h-full w-full object-cover object-top"
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <ImageOff className="h-5 w-5 text-muted-foreground/50" />
        )}
      </div>
      <div className="p-1.5 space-y-1">
        <div className="flex items-center gap-1">
          <span className={`rounded px-1 text-[9px] uppercase ${KIND_BADGE[checkpoint.kind]}`}>
            {checkpoint.kind}
          </span>
          <span className="text-[9px] text-muted-foreground ml-auto" title={time?.toLocaleString()}>
            {time ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
          </span>
        </div>
        <div className="text-[10px] leading-tight line-clamp-2 break-words" title={checkpoint.label}>
          {checkpoint.label || checkpoint.commit_sha.slice(0, 7)}
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <button
            type="button"
            onClick={onViewDiff}
            className="text-indigo-600 hover:underline"
            title="Open this checkpoint's changes as a diff tab"
          >
            Diff
          </button>
          <button
            type="button"
            onClick={onRestore}
            disabled={busy}
            className="flex items-center gap-0.5 text-amber-700 dark:text-amber-300 hover:underline disabled:opacity-40"
            title="Restore the working tree to this checkpoint (forward-only: lands as a new commit)"
          >
            <History className="h-3 w-3" /> {busy ? '…' : 'Restore'}
          </button>
        </div>
      </div>
    </div>
  );
}
