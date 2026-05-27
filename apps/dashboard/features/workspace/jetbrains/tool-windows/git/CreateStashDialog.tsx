/**
 * Modal dialog for creating a new git stash.
 *
 * Wraps `projectGit.stashSave` with the two toggles users actually care
 * about: `--include-untracked` and `--keep-index`. The message field is
 * optional — `git stash push` without `-m` produces the conventional
 * "WIP on <branch>: <sha> <subject>" label, which is fine when the
 * change is small and self-evident from context.
 *
 * Soft-success case: when `git stash` exits 0 with "No local changes to
 * save", we surface a neutral toast (not an error) and dismiss. The
 * git CLI returns this on a clean tree even though the operation is
 * a no-op — treating it as an error would be misleading.
 */

import { useState } from 'react';
import { Archive } from 'lucide-react';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import { toast } from '../../../../../components/ui/prompt-dialog.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../../components/ui/dialog.js';

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface CreateStashDialogProps {
  projectId: number;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateStashDialog({ projectId, onClose, onCreated }: CreateStashDialogProps) {
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [keepIndex, setKeepIndex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiCall<GitRunResult>('projectGit.stashSave', {
        projectId,
        message: message.trim() || undefined,
        includeUntracked,
        keepIndex,
      });
      if (r.ok) {
        if (/no local changes to save/i.test(r.stdout)) {
          toast.message('Nothing to stash', { description: 'Working tree is clean.' });
        } else {
          toast.success('Stashed', {
            description: r.stdout.trim().slice(0, 200) || 'Working tree saved.',
          });
        }
        onCreated();
      } else {
        setErr(r.stderr.trim() || r.stdout.trim() || 'git stash failed');
        setBusy(false);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px] flex items-center gap-2">
            <Archive className="h-4 w-4 text-amber-500" />
            Stash changes
          </DialogTitle>
        </DialogHeader>
        <input
          autoFocus
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Message (optional)"
          className="w-full rounded-md border bg-card px-3 py-2 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(e) => setIncludeUntracked(e.target.checked)}
          />
          <span>Include untracked files</span>
          <span className="text-muted-foreground/70 text-[10.5px]">(--include-untracked)</span>
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={keepIndex}
            onChange={(e) => setKeepIndex(e.target.checked)}
          />
          <span>Keep staged changes</span>
          <span className="text-muted-foreground/70 text-[10.5px]">(--keep-index)</span>
        </label>
        {err && <div className="text-[11px] text-destructive">{err}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={busy}>
            {busy ? 'Stashing…' : 'Stash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
