import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileCode2, GitCommit as GitCommitIcon, Loader2, Tag, Upload } from 'lucide-react';
import type { GitCommitDetail, GitDiffResult, GitPushPreview, GitRunResult } from '@mcp/api-bus';
import { apiCall } from '../../lib/api-client.js';
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
  usePushDialogStore,
  type PushDialogRequest,
} from './push-dialog-store.js';

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

async function executePush(request: PushDialogRequest, preview: GitPushPreview, pushTags: boolean): Promise<string> {
  if (request.kind === 'workspace') {
    const result = await workspaceApi.gitPush(request.sessionId, request.projectId, {
      remote: preview.remote,
      branch: preview.branch,
      targetBranch: preview.targetBranch,
      expectedHead: preview.headSha,
      setUpstream: preview.setUpstream,
      pushTags,
    });
    return result.message;
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
  });
  if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || 'git push failed');
  return result.stderr.trim() || result.stdout.trim();
}

export function PushDialogHost() {
  const request = usePushDialogStore((state) => state.request);
  return request ? <PushDialogBody key={request.id} request={request} /> : null;
}

function PushDialogBody({ request }: { request: PushDialogRequest }) {
  const { t, i18n } = useTranslation('workspace');
  const [preview, setPreview] = useState<GitPushPreview | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [patchTruncated, setPatchTruncated] = useState(false);
  const [pushTags, setPushTags] = useState(false);
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
      setSelectedSha(result.commits[0]?.sha ?? null);
      setError(null);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request]);

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
      const message = await executePush(request, preview, pushTags);
      toast.success(t('git.pushReview.success'), { description: message || t('git.pushReview.successDescription') });
      closePushDialog(request.id);
      try { await request.onPushed?.(); } catch { /* push succeeded; refresh is best-effort */ }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPushing(false);
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
                  <div className="min-w-0 flex-1 overflow-auto bg-muted/10">
                    {patchLoading && <CenteredSpinner />}
                    {!patchLoading && patch === null && (
                      <div className="grid h-full place-items-center px-4 text-center text-[10.5px] text-muted-foreground">{t('git.pushReview.selectFile')}</div>
                    )}
                    {!patchLoading && patch !== null && (
                      <div className="min-w-max p-3">
                        {patchTruncated && <div className="mb-2 text-[10px] text-amber-500">{t('git.pushReview.diffTruncated')}</div>}
                        <pre className="whitespace-pre font-mono text-[10px] leading-4">{patch || t('git.pushReview.emptyDiff')}</pre>
                      </div>
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
              {confirmLabel}
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
