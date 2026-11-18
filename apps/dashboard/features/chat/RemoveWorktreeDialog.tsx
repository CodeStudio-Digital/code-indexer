import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { CoderWorktree, CoderWorktreeRemoval } from '@mcp/api-bus';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { apiPost } from '../../hooks/useApi.js';
import { worktreeLabel } from './WorktreePicker.js';

interface Props {
  projectId: number;
  item: CoderWorktree;
  onClose: () => void;
  restoreFocus: () => void;
  onRefresh: () => void;
  onRemoved: (result: CoderWorktreeRemoval) => void;
}

export function RemoveWorktreeDialog({ projectId, item, onClose, restoreFocus, onRefresh, onRemoved }: Props) {
  const { t } = useTranslation(['chat', 'common']);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [discardChanges, setDiscardChanges] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [error, setError] = useState('');
  const [reselect, setReselect] = useState(false);
  const remove = async () => {
    if (submitting.current || reselect) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await apiPost<CoderWorktreeRemoval>('/coder/worktrees/remove', {
        project_id: projectId, path: item.path, branch: item.branch, head: item.head, confirmed: true, discardChanges, deleteBranch,
      }, undefined, { invalidateReads: false });
      onRemoved(result);
    } catch (cause) {
      const failure = cause as Error & { body?: { code?: string } };
      const code = failure.body?.code;
      if (code === 'dirty') setError(t('chat:worktrees.dirty'));
      else if (code === 'busy') setError(t('chat:worktrees.busy'));
      else if (code === 'activeChat') setError(t('chat:worktrees.activeChat'));
      else if (code === 'terminal') setError(t('chat:worktrees.terminal'));
      else if (code === 'nested') setError(t('chat:worktrees.nested'));
      else if (code === 'changed' || code === 'protected' || code === 'unknown' || cause instanceof TypeError) {
        setReselect(true);
        setError(t(code === 'unknown' || cause instanceof TypeError ? 'chat:worktrees.unknown' : 'chat:worktrees.changed'));
      } else setError(failure.message || String(cause));
      onRefresh();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open && !submitting.current) onClose(); }}>
      <DialogContent className="max-w-lg" onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
        <DialogHeader>
          <DialogTitle>{t('chat:worktrees.removeNamed', { name: worktreeLabel(item) })}</DialogTitle>
          <DialogDescription>{t('chat:worktrees.removeDescription')}</DialogDescription>
        </DialogHeader>
        <code className="select-all break-all rounded border bg-muted/40 px-3 py-2 text-xs">{item.path}</code>
        {!item.prunable && <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={busy || reselect} checked={discardChanges}
            onChange={event => setDiscardChanges(event.target.checked)} />
          {t('chat:worktrees.discard')}
        </label>}
        {item.branch && item.head && !/^0+$/.test(item.head) && <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={busy || reselect} checked={deleteBranch}
            onChange={event => setDeleteBranch(event.target.checked)} />
          <span className="min-w-0 break-words">{t('chat:worktrees.deleteBranch', { branch: item.branch })}
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('chat:worktrees.branchConsequence')}</span>
          </span>
        </label>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button variant="destructive" disabled={busy || reselect} onClick={() => void remove()}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('chat:worktrees.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
