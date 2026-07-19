import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, FileCode2, GitCommit as GitCommitIcon, Loader2, Tag, Upload, UserRound } from 'lucide-react';
import type {
  GitCommitDetail,
  GitDiffResult,
  GitIdentityMode,
  GitHubRepositoryConnection,
  GitPullRequestResult,
  GitPushActionRequired,
  GitPushPreview,
  GitRunResult,
} from '@mcp/api-bus';
import { apiCall } from '../../lib/api-client.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { cn } from '../../lib/utils.js';
import { workspaceApi } from '../builder/preview/api.js';
import {
  closePushDialog,
  type PushDialogRequest,
} from './push-dialog-store.js';
import { CommitFileDiff } from './CommitFileDiff.js';

async function loadPreview(request: PushDialogRequest): Promise<GitPushPreview> {
  if (request.kind === 'workspace') return workspaceApi.gitPushPreview(request.sessionId, request.projectId);
  return apiCall<GitPushPreview>('projectGit.pushPreview', {
    projectId: request.projectId,
    repoPath: request.repoPath,
    remote: request.remote,
    branch: request.branch,
    setUpstream: request.setUpstream,
  });
}

async function loadCommit(request: PushDialogRequest, sha: string): Promise<GitCommitDetail> {
  if (request.kind === 'workspace') return workspaceApi.gitCommitDetail(request.sessionId, request.projectId, sha);
  return apiCall<GitCommitDetail>('projectGit.commitDetail', {
    projectId: request.projectId,
    repoPath: request.repoPath,
    sha,
  });
}

async function loadFileDiff(request: PushDialogRequest, sha: string, path: string): Promise<{ patch: string; truncated?: boolean }> {
  if (request.kind === 'workspace') {
    const result = await workspaceApi.gitCommitFileDiff(request.sessionId, request.projectId, sha, path);
    return { patch: result.diff, truncated: result.truncated };
  }
  return apiCall<GitDiffResult>('projectGit.commitFileDiff', {
    projectId: request.projectId,
    repoPath: request.repoPath,
    sha,
    path,
  });
}

interface PushExecutionResult {
  message: string;
  updatedBeforePush: boolean;
}

function pushError(message: string, code?: GitPushActionRequired): Error {
  const error = new Error(message) as Error & { code?: GitPushActionRequired };
  error.code = code;
  return error;
}

async function executePush(
  request: PushDialogRequest,
  preview: GitPushPreview,
  pushTags: boolean,
  identityMode: GitIdentityMode,
  managedGrant?: string,
): Promise<PushExecutionResult> {
  if (request.kind === 'workspace') {
    const result = await workspaceApi.gitPush(request.sessionId, request.projectId, {
      remote: preview.remote,
      branch: preview.branch,
      targetBranch: preview.targetBranch,
      expectedHead: preview.headSha,
      setUpstream: preview.setUpstream,
      pushTags,
    });
    return { message: result.message, updatedBeforePush: result.updatedBeforePush };
  }
  const result = await apiCall<GitRunResult>('projectGit.push', {
    projectId: request.projectId,
    repoPath: request.repoPath,
    remote: preview.remote,
    branch: preview.branch,
    targetBranch: preview.targetBranch,
    expectedHead: preview.headSha,
    setUpstream: preview.setUpstream,
    force: request.force,
    pushTags,
    identityMode,
    managedGrant,
  });
  if (!result.ok) {
    throw pushError(
      result.stderr.trim() || result.stdout.trim() || 'git push failed',
      result.pushActionRequired,
    );
  }
  return {
    message: result.stderr.trim() || result.stdout.trim(),
    updatedBeforePush: result.updatedBeforePush === true,
  };
}

export function PushDialog({ request }: { request: PushDialogRequest }) {
  const { t, i18n } = useTranslation('workspace');
  const [preview, setPreview] = useState<GitPushPreview | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [patchTruncated, setPatchTruncated] = useState(false);
  const [pushTags, setPushTags] = useState(false);
  const [identityMode, setIdentityMode] = useState<GitIdentityMode>('project');
  const [createPullRequest, setCreatePullRequest] = useState(false);
  const [managedConnection, setManagedConnection] = useState<GitHubRepositoryConnection | null>(null);
  const [managedChecking, setManagedChecking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [patchLoading, setPatchLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commitScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadPreview(request).then((result) => {
      if (!active) return;
      setPreview(result);
      setIdentityMode(request.kind === 'project' ? result.identity?.defaultMode ?? 'project' : 'project');
      setCreatePullRequest(false);
      setSelectedSha(result.commits[0]?.sha ?? null);
      setError(null);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request]);

  const managedTarget = useMemo(() => {
    const identity = preview?.identity?.managed;
    const parts = identity?.repository?.split('/') ?? [];
    if (!identity?.host || parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { host: identity.host, owner: parts[0], repo: parts[1] };
  }, [preview]);

  const refreshManagedConnection = useCallback(async () => {
    if (!managedTarget || request.kind !== 'project') {
      setManagedConnection(null);
      return;
    }
    setManagedChecking(true);
    try {
      const connection = await cloudCall('github.repository', managedTarget);
      setManagedConnection(connection);
      if (!connection.available) {
        setIdentityMode('project');
        setCreatePullRequest(false);
      }
    } catch {
      setManagedConnection({ available: false, configured: true, reason: 'not_connected' });
      setIdentityMode('project');
      setCreatePullRequest(false);
    } finally {
      setManagedChecking(false);
    }
  }, [managedTarget, request.kind]);

  useEffect(() => {
    void refreshManagedConnection();
    const onFocus = () => void refreshManagedConnection();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshManagedConnection]);

  useEffect(() => {
    setDetail(null);
    setSelectedFile(null);
    setPatch(null);
    if (!selectedSha) return;
    let active = true;
    setDetailLoading(true);
    void loadCommit(request, selectedSha).then((result) => {
      if (active) setDetail(result);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [request, selectedSha]);

  const commits = preview?.commits ?? [];
  const commitVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => commitScrollRef.current,
    estimateSize: () => 48,
    getItemKey: (index) => commits[index]?.sha ?? index,
    overscan: 8,
  });
  const pushable = !!preview && (preview.commitCount > 0 || (pushTags && preview.tagCount > 0));
  const managedIdentity = preview?.identity?.managed
    ? {
        ...preview.identity.managed,
        available: managedConnection?.available ?? false,
        configured: managedConnection?.configured ?? preview.identity.managed.configured,
        reason: managedConnection?.reason ?? (managedConnection ? undefined : preview.identity.managed.reason),
      }
    : null;
  const confirmLabel = pushTags
    ? preview?.commitCount
      ? t('git.pushReview.confirmWithTags', { count: preview.commitCount })
      : t('git.pushReview.confirmTags')
    : t('git.pushReview.confirm', { count: preview?.commitCount ?? 0 });
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }), [i18n.language]);

  const selectFile = async (path: string) => {
    if (!detail || patchLoading) return;
    setSelectedFile(path);
    setPatch(null);
    setPatchLoading(true);
    try {
      const result = await loadFileDiff(request, detail.sha, path);
      setPatch(result.patch);
      setPatchTruncated(result.truncated === true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPatchLoading(false);
    }
  };

  const confirmPush = async () => {
    if (!preview || !pushable || pushing) return;
    setPushing(true);
    setError(null);
    try {
      let managedGrant: string | undefined;
      if (identityMode === 'managed') {
        if (!managedTarget || !managedConnection?.available) throw new Error(t('git.pushReview.managedUnavailable.not_connected'));
        managedGrant = (await cloudCall('github.createGrant', { ...managedTarget, operation: 'push' })).grant;
      }
      const result = await executePush(request, preview, pushTags, identityMode, managedGrant);
      let pullRequest: GitPullRequestResult | null = null;
      if (
        createPullRequest &&
        request.kind === 'project' &&
        identityMode === 'managed' &&
        preview.defaultBranch
      ) {
        try {
          if (!managedTarget) throw new Error(t('git.pushReview.managedUnavailable.invalid_remote'));
          pullRequest = await cloudCall('github.createPullRequest', {
            ...managedTarget,
            head: preview.branch,
            base: preview.defaultBranch,
            title: preview.commits[0]?.subject || preview.branch,
            body: 'Created by MegaBrainStudio.',
            draft: true,
          });
        } catch (cause) {
          toast.error(t('git.pushReview.pushSucceededPrFailed'), {
            description: cause instanceof Error ? cause.message : String(cause),
          });
          closePushDialog(request.id);
          try { await request.onPushed?.(); } catch { /* push succeeded; refresh is best-effort */ }
          return;
        }
      }
      toast.success(t('git.pushReview.success'), {
        description: pullRequest
          ? t('git.pushReview.pullRequestCreated', { number: pullRequest.number, url: pullRequest.url })
          : result.updatedBeforePush
          ? t('git.pushReview.successAfterUpdate')
          : result.message || t('git.pushReview.successDescription'),
      });
      closePushDialog(request.id);
      try { await request.onPushed?.(); } catch { /* push succeeded; refresh is best-effort */ }
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause
        ? (cause as { code?: string }).code
        : undefined;
      const message = code === 'git_push_conflicts'
        ? t('git.pushReview.conflicts')
        : code === 'git_push_worktree_dirty'
          ? t('git.pushReview.worktreeDirty')
          : code === 'git_push_update_required'
            ? t('git.pushReview.updateRequired')
            : code === 'git_push_preview_stale'
              ? t('git.pushReview.previewStale')
              : cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setPushing(false);
    }
  };

  const connectManagedIdentity = async () => {
    setError(null);
    try {
      const { url } = await cloudCall('github.connect', undefined);
      (globalThis as { electronAPI?: { openExternal?: (value: string) => void } }).electronAPI?.openExternal?.(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pushing) closePushDialog(request.id); }}>
      <DialogContent className="flex h-[min(82vh,720px)] w-[min(96vw,1040px)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Upload className="h-4 w-4 text-primary" />
            {t('git.pushReview.title')}
          </DialogTitle>
          <DialogDescription>{t('git.pushReview.description')}</DialogDescription>
          {preview && (
            <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 font-mono text-[11px] text-foreground">
              <span className="truncate font-semibold">{preview.branch}</span>
              <span className="text-muted-foreground">→</span>
              <span className="truncate text-primary">{preview.remote}/{preview.targetBranch}</span>
              {preview.setUpstream && <span className="ml-auto shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">{t('git.pushReview.setUpstream')}</span>}
            </div>
          )}
          {request.kind === 'project' && preview?.identity && managedIdentity && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px]">
              <span className="mr-1 text-muted-foreground">{t('git.pushReview.identity')}</span>
              <button
                type="button"
                disabled={pushing}
                onClick={() => { setIdentityMode('project'); setCreatePullRequest(false); }}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 transition-colors',
                  identityMode === 'project' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted/50',
                )}
              >
                <UserRound className="h-3.5 w-3.5" />
                {t('git.pushReview.projectIdentity')}
              </button>
              <button
                type="button"
                disabled={pushing || managedChecking || !managedIdentity.available}
                title={!managedIdentity.available ? t(`git.pushReview.managedUnavailable.${managedIdentity.reason || 'not_configured'}`) : undefined}
                onClick={() => setIdentityMode('managed')}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                  identityMode === 'managed' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted/50',
                )}
              >
                <Bot className="h-3.5 w-3.5" />
                {managedChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {managedIdentity.label}
              </button>
              {!managedIdentity.available && ['not_connected', 'not_installed'].includes(managedIdentity.reason || '') ? (
                <button type="button" className="text-primary hover:underline" onClick={() => void connectManagedIdentity()}>
                  {t('git.pushReview.connectManaged')}
                </button>
              ) : null}
              <span className="text-muted-foreground">
                {identityMode === 'managed'
                  ? t('git.pushReview.managedIdentityHint')
                  : t('git.pushReview.projectIdentityHint')}
              </span>
              {identityMode === 'managed' && preview.defaultBranch && preview.defaultBranch !== preview.branch && (
                <label className="ml-auto flex items-center gap-2 text-foreground">
                  <input
                    type="checkbox"
                    checked={createPullRequest}
                    disabled={pushing}
                    onChange={(event) => setCreatePullRequest(event.target.checked)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {t('git.pushReview.createDraftPr', { base: preview.defaultBranch })}
                </label>
              )}
            </div>
          )}
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <section className="flex w-[340px] shrink-0 flex-col border-r">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-[11px] font-medium">
              <GitCommitIcon className="h-3.5 w-3.5" />
              {t('git.pushReview.commits', { count: preview?.commitCount ?? 0 })}
              {preview?.commitsTruncated && <span className="ml-auto text-[9px] text-amber-500">{t('git.pushReview.truncated')}</span>}
            </div>
            <div ref={commitScrollRef} className="min-h-0 flex-1 overflow-y-auto">
              {loading && <CenteredSpinner />}
              {!loading && commits.length === 0 && (
                <div className="px-4 py-8 text-center text-[11px] text-muted-foreground">{t('git.pushReview.noCommits')}</div>
              )}
              <div style={{ height: commitVirtualizer.getTotalSize(), position: 'relative' }}>
                {commitVirtualizer.getVirtualItems().map((item) => {
                  const commit = commits[item.index]!;
                  return (
                    <button
                      key={item.key}
                      ref={commitVirtualizer.measureElement}
                      data-index={item.index}
                      type="button"
                      onClick={() => setSelectedSha(commit.sha)}
                      className={cn(
                        'absolute left-0 top-0 w-full border-b px-3 py-1.5 text-left hover:bg-muted/50',
                        selectedSha === commit.sha && 'bg-primary/10',
                      )}
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <div className="truncate text-[11.5px] font-medium">{commit.subject}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[9.5px] text-muted-foreground">
                        <span className="font-mono text-primary">{commit.shortSha}</span>
                        <span className="truncate">{commit.author}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="flex min-w-0 flex-1 flex-col">
            {detailLoading && <CenteredSpinner />}
            {!detailLoading && !detail && (
              <div className="grid flex-1 place-items-center text-[11px] text-muted-foreground">{t('git.pushReview.selectCommit')}</div>
            )}
            {detail && (
              <>
                <div className="shrink-0 border-b px-4 py-3">
                  <div className="text-sm font-semibold">{detail.subject}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                    <span>{`${detail.author} <${detail.authorEmail}>`}</span>
                    <span>{dateFormatter.format(new Date(detail.date))}</span>
                    <span className="font-mono text-primary">{detail.shortSha}</span>
                  </div>
                  {detail.body && <p className="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground">{detail.body}</p>}
                </div>
                <div className="flex min-h-0 flex-1">
                  <div className="w-[42%] min-w-[230px] overflow-y-auto border-r">
                    <div className="sticky top-0 border-b bg-card px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('git.pushReview.files', { count: detail.files.length })}
                    </div>
                    {detail.files.map((file) => (
                      <button
                        key={`${file.oldPath ?? ''}:${file.path}`}
                        type="button"
                        onClick={() => void selectFile(file.path)}
                        className={cn(
                          'flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-[10.5px] hover:bg-muted/50',
                          selectedFile === file.path && 'bg-primary/10',
                        )}
                      >
                        <FileCode2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{file.path}</span>
                        {file.additions > 0 && <span className="font-mono text-emerald-500">+{file.additions}</span>}
                        {file.deletions > 0 && <span className="font-mono text-destructive">-{file.deletions}</span>}
                      </button>
                    ))}
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden bg-muted/10">
                    {patchLoading && <CenteredSpinner />}
                    {!patchLoading && patch === null && (
                      <div className="grid h-full place-items-center px-4 text-center text-[10.5px] text-muted-foreground">{t('git.pushReview.selectFile')}</div>
                    )}
                    {!patchLoading && patch !== null && (
                      <CommitFileDiff patch={patch} path={selectedFile ?? ''} truncated={patchTruncated} />
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>

        {error && <div className="shrink-0 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-[11px] text-destructive">{error}</div>}
        <DialogFooter className="shrink-0 items-center gap-3 border-t px-4 py-3 sm:justify-between sm:space-x-0">
          <div className="flex min-w-0 items-center gap-2">
            <label className={cn('flex items-center gap-2 text-[11px]', !preview?.tagCount && 'opacity-50')}>
              <input
                type="checkbox"
                checked={pushTags}
                disabled={!preview?.tagCount || pushing}
                onChange={(event) => setPushTags(event.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              <Tag className="h-3.5 w-3.5" />
              {t('git.pushReview.pushTags', { count: preview?.tagCount ?? 0 })}
            </label>
            {!!preview?.tags.length && (
              <span className="max-w-[280px] truncate font-mono text-[9.5px] text-muted-foreground" title={preview.tags.map((tag) => tag.name).join(', ')}>
                {preview.tags.map((tag) => tag.name).join(', ')}{preview.tagsTruncated ? '…' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={pushing} onClick={() => closePushDialog(request.id)}>{t('git.pushReview.cancel')}</Button>
            <Button size="sm" disabled={!pushable || pushing || loading} onClick={() => void confirmPush()}>
              {pushing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
              {pushing ? t('git.pushReview.syncing') : confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CenteredSpinner() {
  return (
    <div className="grid h-full min-h-20 place-items-center text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  );
}
