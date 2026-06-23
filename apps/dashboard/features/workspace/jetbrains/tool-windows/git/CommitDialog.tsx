/**
 * Shared commit dialog — modal textarea + Commit button. Used by both
 * the Git tool window (Commit toolbar action) and the workspace
 * status-bar branch popover (the "Commit…" quick action).
 *
 * Stays a dumb component: caller controls open/close + reacts to
 * `onCommitted` to refresh whatever it owns (status chips, file tree,
 * etc.). Only knows about projectId + the staged count to nudge the
 * user away from empty commits.
 */
import { useState } from 'react';
import { GitCommit as GitCommitIcon } from 'lucide-react';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../../components/ui/dialog.js';

export interface CommitDialogProps {
  projectId: number;
  /** Renders the "Commit N files" header. Pass 0 to disable the Commit button. */
  stagedCount: number;
  onClose: () => void;
  onCommitted: () => void;
}

export function CommitDialog({ projectId, stagedCount, onClose, onCommitted }: CommitDialogProps) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const commit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiCall<{ sha: string }>('projectGit.commit', { projectId, message });
      onCommitted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-[14px] flex items-center gap-2">
            <GitCommitIcon className="h-4 w-4 text-primary" />
            {stagedCount > 0
              ? `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`
              : 'Commit'}
          </DialogTitle>
        </DialogHeader>
        {stagedCount === 0 && (
          <div className="text-[11.5px] text-muted-foreground">
            Nothing staged. Open the Git tool window to stage changes first.
          </div>
        )}
        <textarea
          autoFocus
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message…"
          className="w-full min-h-[140px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-mono focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        {err && <div className="text-[11px] text-destructive">{err}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void commit()}
            disabled={busy || !message.trim() || stagedCount === 0}
          >
            {busy ? 'Committing…' : 'Commit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
