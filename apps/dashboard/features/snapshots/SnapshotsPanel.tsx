import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { ArrowLeft } from 'lucide-react';
import { useConfirm } from '../../components/ui/dialog-provider.js';
import { cn } from '../../lib/utils.js';
import { SnapshotFileList } from './SnapshotFileList.js';
import { SnapshotDiffViewer } from './SnapshotDiffViewer.js';
import { SnapshotReviewQueue } from './SnapshotReviewQueue.js';
import { useSelectedDiff } from './diff/useSelectedDiff.js';
import {
  acceptAll,
  acceptFile,
  acceptHunk,
  createReviewComment,
  fetchSnapshotReviews,
  fetchSnapshotList,
  patchReviewComment,
  revertAll,
  revertFile,
  revertHunk,
  runAutoReview,
  submitReviewComments,
} from './api.js';
import type {
  SessionScope,
  SnapshotFileSummary,
  SnapshotReviewComment,
  SnapshotReviewsResponse,
} from './types.js';
import type { AddReviewCommentInput } from './SnapshotDiffViewer.js';

interface Props {
  scope: SessionScope;
  sessionId: number;
  /** When provided, the panel will refetch every time the value changes — used to react
   *  to live `session_snapshot_changed` SSE events from the chat stream. */
  refreshKey?: number;
  /** Baseline to preselect on open (deep-link from a chat "View snapshot" action). */
  initialBaselineId?: number | null;
  onSubmitReviewMessage?: (message: string) => Promise<void>;
}

export function SnapshotsPanel({ scope, sessionId, refreshKey, initialBaselineId, onSubmitReviewMessage }: Props) {
  const { t } = useTranslation('projects');
  const confirm = useConfirm();
  const [files, setFiles] = useState<SnapshotFileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [selectedBaselineId, setSelectedBaselineId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviews, setReviews] = useState<SnapshotReviewsResponse>({ runs: [], comments: [] });
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [contextBefore, setContextBefore] = useState(3);
  const [contextAfter, setContextAfter] = useState(3);
  // mobile: when a baseline is selected, drop the list to focus the diff
  const [mobileShowDiff, setMobileShowDiff] = useState(false);
  // Project filter: `null` shows files from every project. Built from the
  // distinct `projectId`s observed in the loaded snapshot list. Resets to
  // null on session change to avoid showing an empty filter for a project
  // that no longer has snapshots.
  const [projectFilter, setProjectFilter] = useState<number | null>(null);

  useEffect(() => {
    setSelectedBaselineId(initialBaselineId ?? null);
    setShowClosed(false);
    setProjectFilter(null);
  }, [sessionId, initialBaselineId]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // Keep closed global baselines loaded (but hidden by the list toggle) so
      // an approved original remains discoverable and restorable for the full
      // lifetime of the session.
      const r = await fetchSnapshotList(scope, sessionId, { includeClosed: true });
      setFiles(r.files);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, sessionId]);

  const reloadReviews = useCallback(async () => {
    try {
      const r = await fetchSnapshotReviews(scope, sessionId);
      setReviews(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [scope, sessionId]);

  useEffect(() => {
    void reload();
    void reloadReviews();
  }, [reload, reloadReviews]);

  // A chat round can deep-link to a global baseline that was already approved.
  // Keep the global modal as the durable rollback surface by automatically
  // revealing closed baselines instead of silently selecting another file.
  useEffect(() => {
    if (
      initialBaselineId != null
      && !loading
      && !showClosed
      && files.find((file) => file.baselineId === initialBaselineId)?.status !== 'active'
    ) {
      setShowClosed(true);
    }
  }, [initialBaselineId, loading, showClosed, files]);

  const { diff, diffLoading, reloadDiff } = useSelectedDiff({
    scope,
    sessionId,
    selectedBaselineId,
    contextBefore,
    contextAfter,
    refreshKey,
    onReload: reload,
    onReloadReviews: reloadReviews,
    onError: setError,
  });

  // Auto-select the deep-linked baseline if present, else the first active file.
  useEffect(() => {
    if (selectedBaselineId != null) return;
    if (initialBaselineId != null && files.some((f) => f.baselineId === initialBaselineId)) {
      setSelectedBaselineId(initialBaselineId);
      return;
    }
    // Wait for the include-closed reload before falling back; otherwise an
    // active file wins the race and the requested original baseline is hidden.
    if (initialBaselineId != null && !showClosed) return;
    const firstActive = files.find((f) => f.status === 'active');
    if (firstActive) setSelectedBaselineId(firstActive.baselineId);
  }, [files, selectedBaselineId, initialBaselineId, showClosed]);

  const handleSelect = useCallback((baselineId: number) => {
    setSelectedBaselineId(baselineId);
    setContextBefore(3);
    setContextAfter(3);
    setMobileShowDiff(true);
  }, []);

  const handleAcceptHunk = useCallback(async (fingerprint: string) => {
    if (selectedBaselineId == null) return;
    setBusy(true);
    try {
      await acceptHunk(scope, sessionId, selectedBaselineId, fingerprint);
      await reloadDiff(selectedBaselineId);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [scope, sessionId, selectedBaselineId, reloadDiff, reload, t]);

  const handleRevertHunk = useCallback(async (fingerprint: string) => {
    if (selectedBaselineId == null) return;
    setBusy(true);
    try {
      const r = await revertHunk(scope, sessionId, selectedBaselineId, fingerprint);
      if (!r.ok && r.reason) {
        setError(t('snapshotPanel.revertHunkFailed', { reason: r.reason }));
      }
      await reloadDiff(selectedBaselineId);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [scope, sessionId, selectedBaselineId, reloadDiff, reload, t]);

  const handleAcceptFile = useCallback(async () => {
    if (selectedBaselineId == null) return;
    setBusy(true);
    try {
      await acceptFile(scope, sessionId, selectedBaselineId);
      await reload();
      setSelectedBaselineId(null);
    } finally {
      setBusy(false);
    }
  }, [scope, sessionId, selectedBaselineId, reload]);

  const handleRevertFile = useCallback(async () => {
    if (selectedBaselineId == null) return;
    const ok = await confirm({
      title: t('snapshotPanel.revertFile.title'),
      description: t('snapshotPanel.revertFile.description', { file: diff?.baseline.filePath ?? t('snapshotDiff.file') }),
      confirmLabel: t('snapshotPanel.revertFile.confirm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await revertFile(scope, sessionId, selectedBaselineId);
      if (!r.ok && r.reason) setError(t('snapshotPanel.revertFile.failed', { reason: r.reason }));
      await reload();
      setSelectedBaselineId(null);
    } finally {
      setBusy(false);
    }
  }, [scope, sessionId, selectedBaselineId, reload, confirm, diff?.baseline.filePath, t]);

  const handleAcceptAll = useCallback(async () => {
    const activeCount = files.filter((f) => f.status === 'active').length;
    if (activeCount === 0) return;
    const ok = await confirm({
      title: t('snapshotPanel.keepAll.title', { count: activeCount }),
      description: t('snapshotPanel.keepAll.description'),
      confirmLabel: t('snapshotPanel.keepAll.confirm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await acceptAll(scope, sessionId);
      await reload();
      setSelectedBaselineId(null);
    } finally {
      setBusy(false);
    }
  }, [files, scope, sessionId, reload, confirm, t]);

  const handleRevertAll = useCallback(async () => {
    const activeCount = files.filter((f) => f.status === 'active').length;
    if (activeCount === 0) return;
    const ok = await confirm({
      title: t('snapshotPanel.revertAll.title', { count: activeCount }),
      description: t('snapshotPanel.revertAll.description'),
      confirmLabel: t('snapshotPanel.revertAll.confirm'),
      variant: 'destructive',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await revertAll(scope, sessionId);
      await reload();
      setSelectedBaselineId(null);
    } finally {
      setBusy(false);
    }
  }, [files, scope, sessionId, reload, confirm, t]);

  const handleAddReviewComment = useCallback(async (input: AddReviewCommentInput) => {
    setReviewBusy(true);
    try {
      const r = await createReviewComment(scope, sessionId, input);
      setReviews((prev) => ({ ...prev, comments: [...prev.comments, r.comment] }));
      setReviewNotice(t('snapshotPanel.reviewCommentAdded'));
      await reloadReviews();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  }, [scope, sessionId, reloadReviews, t]);

  const handleUpdateReviewComment = useCallback(async (
    id: number,
    patch: Partial<Pick<SnapshotReviewComment, 'status'>>,
  ) => {
    setReviewBusy(true);
    try {
      const r = await patchReviewComment(scope, sessionId, id, patch);
      setReviews((prev) => ({
        ...prev,
        comments: prev.comments.map((comment) => (comment.id === id ? r.comment : comment)),
      }));
      await reloadReviews();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  }, [scope, sessionId, reloadReviews, t]);

  const handleAutoReview = useCallback(async () => {
    setReviewBusy(true);
    try {
      const r = await runAutoReview(scope, sessionId);
      if (r.comments.length > 0) {
        setReviews((prev) => ({ ...prev, comments: [...prev.comments, ...r.comments] }));
        setReviewNotice(t('snapshotPanel.autoReview.created', { count: r.comments.length }));
      } else {
        setReviewNotice(r.message ?? t('snapshotPanel.autoReview.none'));
      }
      await reloadReviews();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  }, [scope, sessionId, reloadReviews, t]);

  const handleSubmitReview = useCallback(async () => {
    // Coder forwards via the chat stream callback; company has no callback
    // and relies on server-side delivery to the master (response.delivered).
    if (!onSubmitReviewMessage && scope !== 'company') return;
    const ids = reviews.comments
      .filter((c) =>
        (c.source === 'manual' && c.status === 'open') ||
        (c.source === 'auto' && c.status === 'accepted'),
      )
      .map((c) => c.id);
    if (ids.length === 0) return;
    setReviewBusy(true);
    try {
      const r = await submitReviewComments(scope, sessionId, ids);
      if (onSubmitReviewMessage) {
        await onSubmitReviewMessage(r.message);
        setReviewNotice(t('snapshotPanel.reviewSent', { count: ids.length }));
      } else if (r.pending === 'interactive_wait') {
        setReviewNotice(t('snapshotPanel.reviewPending'));
      } else if (r.delivered) {
        setReviewNotice(t('snapshotPanel.reviewSentMaster', { count: ids.length }));
      } else {
        setReviewNotice(t('snapshotPanel.reviewUndelivered'));
      }
      await reloadReviews();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  }, [scope, sessionId, reviews.comments, onSubmitReviewMessage, reloadReviews, t]);

  const handleExpandContext = useCallback((side: 'before' | 'after') => {
    if (side === 'before') setContextBefore((v) => v + 10);
    else setContextAfter((v) => v + 10);
  }, []);

  const activeCount = useMemo(() => files.filter((f) => f.status === 'active').length, [files]);
  const canSubmitReview = useMemo(
    () =>
      // Coder needs the chat callback; company delivers server-side to the master.
      (!!onSubmitReviewMessage || scope === 'company') &&
      reviews.comments.some((c) =>
        (c.source === 'manual' && c.status === 'open') ||
        (c.source === 'auto' && c.status === 'accepted'),
      ),
    [reviews.comments, onSubmitReviewMessage, scope],
  );
  // Distinct projects across the loaded files. Stable order by name.
  const projects = useMemo(() => {
    const seen = new Map<number, string>();
    for (const f of files) {
      if (f.projectId != null && f.projectName) seen.set(f.projectId, f.projectName);
    }
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [files]);
  const filesForList = useMemo(
    () => (projectFilter == null ? files : files.filter((f) => f.projectId === projectFilter)),
    [files, projectFilter],
  );
  // The list view receives filtered files. Reset the selected baseline
  // when the project filter changes and the current selection is no
  // longer visible — otherwise the diff pane would show stale data.
  useEffect(() => {
    if (selectedBaselineId == null) return;
    const stillVisible = filesForList.some((f) => f.baselineId === selectedBaselineId);
    if (!stillVisible) setSelectedBaselineId(null);
  }, [filesForList, selectedBaselineId]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          {mobileShowDiff && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setMobileShowDiff(false)}
              className="lg:hidden h-7 w-7 flex-shrink-0"
              aria-label={t('snapshotPanel.backToList')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <h2 className="font-medium text-sm truncate">
            {t('snapshotPanel.title')} <span className="text-muted-foreground">{t('snapshotPanel.activeCount', { count: activeCount })}</span>
          </h2>
          {projects.length > 1 && (
            <select
              className="text-xs bg-background border rounded px-1.5 py-0.5 max-w-[160px]"
              value={projectFilter ?? ''}
              onChange={(e) =>
                setProjectFilter(e.target.value === '' ? null : Number(e.target.value))
              }
              title={t('snapshotPanel.filterByProject')}
            >
              <option value="">{t('snapshotPanel.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          <Button
            size="sm"
            variant="default"
            disabled={busy || activeCount === 0}
            onClick={handleAcceptAll}
            className="h-7 text-xs px-2"
          >
            {t('snapshotPanel.keepAll')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || activeCount === 0}
            onClick={handleRevertAll}
            className="h-7 text-xs px-2"
          >
            {t('snapshotPanel.revertAll')}
          </Button>
        </div>
      </div>
      {error && (
        <div className="px-3 py-1.5 text-xs bg-destructive/10 text-destructive border-b">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">{t('snapshotPanel.dismiss')}</button>
        </div>
      )}
      {reviewNotice && (
        <div className="px-3 py-1.5 text-xs bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-b">
          {reviewNotice}
          <button onClick={() => setReviewNotice(null)} className="ml-2 underline">{t('snapshotPanel.dismiss')}</button>
        </div>
      )}
      <SnapshotReviewQueue
        comments={reviews.comments}
        selectedBaselineId={selectedBaselineId}
        busy={reviewBusy || busy}
        canSubmit={canSubmitReview}
        onSelectBaseline={handleSelect}
        onUpdateComment={handleUpdateReviewComment}
        onSubmit={handleSubmitReview}
      />
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_1fr]">
        {/* File list — hidden on mobile when a diff is being viewed */}
        <div
          className={cn(
            'border-r min-h-0 flex flex-col',
            mobileShowDiff && 'hidden lg:flex',
          )}
        >
          {loading ? (
            <div className="p-3 text-xs text-muted-foreground">{t('snapshotPanel.loading')}</div>
          ) : (
            <SnapshotFileList
              files={filesForList}
              selectedBaselineId={selectedBaselineId}
              onSelect={handleSelect}
              showClosed={showClosed}
              onToggleShowClosed={setShowClosed}
              showProjectLabel={projects.length > 1 && projectFilter == null}
            />
          )}
        </div>
        {/* Diff pane — hidden on mobile until a file is selected */}
        <div
          className={cn(
            'min-h-0 min-w-0 flex flex-col',
            !mobileShowDiff && 'hidden lg:flex',
          )}
        >
          {selectedBaselineId == null ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground italic">
              {t('snapshotPanel.selectFile')}
            </div>
          ) : diffLoading || !diff ? (
            <div className="p-3 text-xs text-muted-foreground">{t('snapshotPanel.loadingDiff')}</div>
          ) : (
            <SnapshotDiffViewer
              diff={diff}
              comments={reviews.comments}
              onAcceptHunk={handleAcceptHunk}
              onRevertHunk={handleRevertHunk}
              onAcceptFile={handleAcceptFile}
              onRevertFile={handleRevertFile}
              onAddComment={handleAddReviewComment}
              onUpdateComment={handleUpdateReviewComment}
              onAutoReview={handleAutoReview}
              onSubmitReview={handleSubmitReview}
              onExpandContext={handleExpandContext}
              busy={busy}
              reviewBusy={reviewBusy}
              canSubmitReview={canSubmitReview}
            />
          )}
        </div>
      </div>
    </div>
  );
}
