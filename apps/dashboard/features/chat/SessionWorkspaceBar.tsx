import { useLayoutEffect, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { GitFork, Loader2, Plus, RefreshCw } from 'lucide-react';
import type { CoderWorktree, CoderWorktrees } from '@mcp/api-bus';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { WorktreePicker, worktreeLabel } from './WorktreePicker.js';
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog.js';
import { apiPost } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import { worktreeKey } from '../../state/worktree-selection.js';

interface Props {
  projectId?: number;
  isGlobal: boolean;
  path: string | null;
  data: CoderWorktrees | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  sessionError: string | null;
  actionsRef: Ref<HTMLDivElement>;
  onSelect: (path: string | null) => void;
  onRefresh: () => void;
}

export function SessionWorkspaceBar(props: Props) {
  const { t } = useTranslation(['chat', 'common']);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CoderWorktree | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const latest = useRef<Props | null>(props);
  useLayoutEffect(() => {
    latest.current = props;
    return () => { latest.current = null; };
  }, [props]);

  const create = async () => {
    if (creatingRef.current || props.projectId == null) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await apiPost<{ path: string }>('/coder/worktrees', {
        project_id: props.projectId,
        name: name.trim(),
        branch: branch.trim() || `codex/${name.trim()}`,
      });
      props.onRefresh();
      props.onSelect(result.path);
      setOpen(false);
      setName('');
      setBranch('');
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
      props.onRefresh();
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div data-testid="session-workspace-bar" className="shrink-0 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-raised)]">
      <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1">
        {!props.isGlobal && <>
          <div className="min-w-0 flex-1 basis-40">
            <WorktreePicker data={props.data} path={props.path} triggerRef={trigger} onSelect={props.onSelect} onRemove={setRemoving} />
          </div>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={props.loading || !props.data?.isGit}
            title={!props.loading && props.data && !props.data.isGit ? t('chat:worktrees.notGit') : undefined}
            onClick={() => { setCreateError(null); setOpen(true); }}>
            <Plus className="h-3.5 w-3.5" />{t('chat:worktrees.create')}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={props.onRefresh} disabled={props.loading}
            aria-label={t('chat:worktrees.refresh')} title={t('chat:worktrees.refresh')}>
            <RefreshCw className={cn('h-3.5 w-3.5', props.loading && 'animate-spin')} />
          </Button>
        </>}
        {props.actionsRef && <div ref={props.actionsRef} className="ml-auto max-w-full overflow-x-auto" />}
      </div>
      {(props.error || props.sessionError || props.unavailable) && <p role="alert" className="border-t px-3 py-1.5 text-xs text-destructive">
        {props.sessionError || (props.error ? t('chat:worktrees.loadError') : t('chat:worktrees.unavailable'))}
      </p>}
      {removing && props.projectId != null && <RemoveWorktreeDialog key={removing.path} item={removing} projectId={props.projectId}
        onClose={() => setRemoving(null)} restoreFocus={() => trigger.current?.focus()} onRefresh={props.onRefresh}
        onRemoved={result => {
          const current = latest.current;
          if (current && current.projectId === props.projectId) {
            if (worktreeKey(current.path) === worktreeKey(removing.path)) current.onSelect(null);
            setRemoving(null);
          }
          props.onRefresh();
          if (result.branchWarning) toast.warning(t('chat:worktrees.branchWarning', { branch: removing.branch }), { description: result.branchWarning });
          else toast.success(t('chat:worktrees.removed', { name: worktreeLabel(removing) }));
        }} />}
      <Dialog open={open} onOpenChange={(value) => { if (!creating) setOpen(value); }}>
        <DialogContent>
          <form onSubmit={(event) => { event.preventDefault(); void create(); }} className="space-y-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><GitFork className="h-4 w-4" />{t('chat:worktrees.create')}</DialogTitle>
              <DialogDescription>{t('chat:worktrees.description')}</DialogDescription>
            </DialogHeader>
            <label className="block space-y-1.5 text-sm">
              <span>{t('chat:worktrees.name')}</span>
              <Input autoFocus required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" value={name}
                placeholder={t('workspace.branchPlaceholder')} disabled={creating} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>{t('chat:worktrees.branch')}</span>
              <Input value={branch} placeholder={`codex/${name || 'feature-login'}`} disabled={creating}
                onChange={(event) => setBranch(event.target.value)} />
            </label>
            <p className="text-xs text-muted-foreground">{t('chat:worktrees.branchHint')}</p>
            {createError && <p role="alert" className="text-sm text-destructive break-words">{createError}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={creating} onClick={() => setOpen(false)}>{t('common:actions.cancel')}</Button>
              <Button type="submit" disabled={creating || !name.trim()}>
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('chat:worktrees.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
