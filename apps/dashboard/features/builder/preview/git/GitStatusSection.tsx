import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Loader2, Upload } from 'lucide-react';
import { workspaceApi, type GitStatusResponse } from '../api.js';
import { GitChangeItem } from './GitChangeItem.js';
import { ConfirmDiscardDialog } from './ConfirmDiscardDialog.js';
import { openWorkspacePushDialog } from '../../../git-push/push-dialog-store.js';

interface Props {
  sessionId: string;
  projectId: number;
  status: GitStatusResponse;
  onRefresh: () => void | Promise<void>;
}

export function GitStatusSection({ sessionId, projectId, status, onRefresh }: Props) {
  const { t } = useTranslation('agents');
  const staged = status.files.filter((f) => f.index !== '.' && f.index !== '?');
  const unstaged = status.files.filter((f) => f.worktree !== '.' && f.index !== '?');
  const untracked = status.files.filter((f) => f.index === '?');
  // Keep Push available while on a branch: even when commits are in sync,
  // the review dialog may still publish local tags.
  const canPush = !!status.branch;

  function handlePush() {
    openWorkspacePushDialog({ sessionId, projectId, onPushed: onRefresh });
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 py-2 border-b flex items-center gap-2 text-xs bg-muted/20">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{status.branch ?? '(sem branch)'}</span>
        {status.upstream && <span className="text-muted-foreground">→ {status.upstream}</span>}
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="text-muted-foreground">
            {status.ahead > 0 && <span>↑{status.ahead} </span>}
            {status.behind > 0 && <span>↓{status.behind}</span>}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={handlePush}
          disabled={!canPush}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed text-[11px]"
          title={
            !canPush
              ? t('git.pushDetached', 'Push is unavailable in detached HEAD')
              : status.upstream
                ? t('git.pushTo', 'Push to {{upstream}}', { upstream: status.upstream })
                : t('git.pushSetUpstream', 'Push --set-upstream origin {{branch}}', { branch: status.branch ?? '' })
          }
        >
          <Upload className="h-3 w-3" />
          {t('git.push', 'Push')}
        </button>
        <span className="text-[10px] text-muted-foreground">{status.files.length} alteraç{status.files.length === 1 ? 'ão' : 'ões'}</span>
      </div>
      {status.files.length === 0 && (
        <div className="px-3 py-4 text-xs text-muted-foreground text-center">
          Nenhuma alteração pendente.
        </div>
      )}
      <ChangeGroup
        title="Staged"
        items={staged}
        sessionId={sessionId}
        projectId={projectId}
        staged
        onRefresh={onRefresh}
      />
      <ChangeGroup
        title="Changes"
        items={unstaged}
        sessionId={sessionId}
        projectId={projectId}
        staged={false}
        onRefresh={onRefresh}
      />
      <ChangeGroup
        title="Untracked"
        items={untracked}
        sessionId={sessionId}
        projectId={projectId}
        staged={false}
        onRefresh={onRefresh}
      />
    </div>
  );
}

function ChangeGroup({
  title,
  items,
  sessionId,
  projectId,
  staged,
  onRefresh,
}: {
  title: string;
  items: GitStatusResponse['files'];
  sessionId: string;
  projectId: number;
  staged: boolean;
  onRefresh: () => void | Promise<void>;
}) {
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  if (items.length === 0) return null;

  async function handleBulk() {
    if (bulkLoading) return;
    setBulkLoading(true);
    setBulkError(null);
    try {
      const paths = items.map((i) => i.path);
      if (staged) {
        await workspaceApi.gitReset(sessionId, projectId, paths);
      } else {
        await workspaceApi.gitAdd(sessionId, projectId, paths);
      }
      await onRefresh();
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleBulkDiscard() {
    setDiscardBusy(true);
    setDiscardError(null);
    try {
      await workspaceApi.gitDiscard(sessionId, projectId, items.map((i) => i.path));
      await onRefresh();
      setDiscardOpen(false);
    } catch (e) {
      setDiscardError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscardBusy(false);
    }
  }

  const canBulkDiscard = !staged;

  return (
    <div>
      <div className="px-3 py-1 bg-muted/10 border-b text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <span>{title} ({items.length})</span>
        <span className="flex-1" />
        {canBulkDiscard && (
          <button
            type="button"
            onClick={() => {
              setDiscardError(null);
              setDiscardOpen(true);
            }}
            disabled={bulkLoading || discardBusy}
            className="normal-case tracking-normal text-[11px] text-destructive hover:underline disabled:opacity-40"
          >
            Descartar todos
          </button>
        )}
        <button
          type="button"
          onClick={handleBulk}
          disabled={bulkLoading}
          className="normal-case tracking-normal text-[11px] text-foreground hover:underline disabled:opacity-40 flex items-center gap-1"
        >
          {bulkLoading && <Loader2 className="h-3 w-3 animate-spin" />}
          {staged ? 'Unstage all' : 'Stage all'}
        </button>
      </div>
      {bulkError && <div className="px-3 py-1 text-xs text-destructive">{bulkError}</div>}
      {items.map((f) => (
        <GitChangeItem
          key={`${title}-${f.path}`}
          sessionId={sessionId}
          projectId={projectId}
          file={f}
          staged={staged}
          onMutated={onRefresh}
        />
      ))}
      {discardOpen && (
        <ConfirmDiscardDialog
          title="Descartar mudanças"
          message={
            <>
              Descartar mudanças em <span className="font-medium text-foreground">{items.length}</span>{' '}
              arquivo{items.length === 1 ? '' : 's'} do grupo <span className="font-medium text-foreground">{title}</span>?
            </>
          }
          confirmLabel="Descartar todos"
          busy={discardBusy}
          error={discardError}
          onConfirm={handleBulkDiscard}
          onCancel={() => setDiscardOpen(false)}
        />
      )}
    </div>
  );
}
