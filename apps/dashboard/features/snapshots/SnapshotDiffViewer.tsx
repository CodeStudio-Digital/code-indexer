import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import type { SnapshotFileDiff, SnapshotHunk } from './types.js';

interface Props {
  diff: SnapshotFileDiff;
  onAcceptHunk: (fingerprint: string) => Promise<void>;
  onRevertHunk: (fingerprint: string) => Promise<void>;
  onAcceptFile: () => Promise<void>;
  onRevertFile: () => Promise<void>;
  busy: boolean;
}

function HunkBlock({
  hunk,
  onAccept,
  onRevert,
  busy,
}: {
  hunk: SnapshotHunk;
  onAccept: () => void;
  onRevert: () => void;
  busy: boolean;
}) {
  const decided = hunk.decision !== 'pending';
  return (
    <div
      className={cn(
        'border rounded-md overflow-hidden bg-card',
        decided && 'opacity-60',
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-muted/30 border-b text-[11px] font-mono">
        <span className="text-muted-foreground">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-emerald-700 dark:text-emerald-400">+{hunk.addedCount}</span>
          <span className="text-rose-700 dark:text-rose-400">-{hunk.removedCount}</span>
          {hunk.decision === 'kept' && <Badge variant="outline" className="text-[9px]">kept</Badge>}
          {hunk.decision === 'reverted' && <Badge variant="outline" className="text-[9px]">reverted</Badge>}
        </div>
      </div>
      <div className="font-mono text-[11.5px] leading-snug overflow-x-auto">
        {hunk.lines.map((line, i) => {
          const bg =
            line.type === 'add'
              ? 'bg-emerald-500/10 dark:bg-emerald-500/15'
              : line.type === 'remove'
                ? 'bg-rose-500/10 dark:bg-rose-500/15'
                : '';
          const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
          return (
            <div key={i} className={cn('flex items-start px-3 whitespace-pre', bg)}>
              <span className="select-none text-muted-foreground w-3">{prefix}</span>
              <span className="flex-1">{line.content || ' '}</span>
            </div>
          );
        })}
      </div>
      {!decided && (
        <div className="flex items-center justify-end gap-1 px-3 py-1.5 bg-muted/20 border-t">
          <Button size="sm" variant="ghost" onClick={onAccept} disabled={busy} className="h-7 text-xs">
            Keep hunk
          </Button>
          <Button size="sm" variant="ghost" onClick={onRevert} disabled={busy} className="h-7 text-xs">
            Undo hunk
          </Button>
        </div>
      )}
    </div>
  );
}

export function SnapshotDiffViewer({
  diff,
  onAcceptHunk,
  onRevertHunk,
  onAcceptFile,
  onRevertFile,
  busy,
}: Props) {
  const [localBusy, setLocalBusy] = useState(false);
  const isBusy = busy || localBusy;

  if (diff.diffDisabled) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6 gap-3 text-sm text-muted-foreground">
        <span>This file is too large or binary to diff hunk-by-hunk.</span>
        <span>You can still revert the whole file or accept it as-is.</span>
        <div className="flex gap-2 mt-2">
          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setLocalBusy(true); onAcceptFile().finally(() => setLocalBusy(false)); }}>
            Keep file
          </Button>
          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setLocalBusy(true); onRevertFile().finally(() => setLocalBusy(false)); }}>
            Revert file
          </Button>
        </div>
      </div>
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6 gap-3 text-sm text-muted-foreground">
        <span>No remaining changes for <code className="font-mono">{diff.baseline.filePath}</code>.</span>
        <span>File matches its baseline.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-card">
        <div className="font-mono text-xs truncate flex-1 min-w-0">{diff.baseline.filePath}</div>
        <div className="flex gap-1.5 flex-shrink-0">
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            onClick={() => { setLocalBusy(true); onAcceptFile().finally(() => setLocalBusy(false)); }}
            className="h-7 text-xs"
          >
            Keep file
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            onClick={() => { setLocalBusy(true); onRevertFile().finally(() => setLocalBusy(false)); }}
            className="h-7 text-xs"
          >
            Revert file
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 bg-background">
        {diff.hunks.map((h) => (
          <HunkBlock
            key={h.fingerprint}
            hunk={h}
            busy={isBusy}
            onAccept={() => { setLocalBusy(true); onAcceptHunk(h.fingerprint).finally(() => setLocalBusy(false)); }}
            onRevert={() => { setLocalBusy(true); onRevertHunk(h.fingerprint).finally(() => setLocalBusy(false)); }}
          />
        ))}
      </div>
    </div>
  );
}
