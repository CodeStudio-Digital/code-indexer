import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { ArrowLeft } from 'lucide-react';
import { useConfirm } from '../../components/ui/dialog-provider.js';
import { cn } from '../../lib/utils.js';
import { SnapshotFileList } from './SnapshotFileList.js';
import { SnapshotDiffViewer } from './SnapshotDiffViewer.js';
import {
  acceptAll,
  acceptFile,
  acceptHunk,
  fetchFileDiff,
  fetchSnapshotList,
  revertAll,
  revertFile,
  revertHunk,
} from './api.js';
import type { SessionScope, SnapshotFileDiff, SnapshotFileSummary } from './types.js';

interface Props {
  scope: SessionScope;
  sessionId: number;
  /** When provided, the panel will refetch every time the value changes — used to react
   *  to live `session_snapshot_changed` SSE events from the chat stream. */
  refreshKey?: number;
}

export function SnapshotsPanel({ scope, sessionId, refreshKey }: Props) {
  const confirm = useConfirm();
  const [files, setFiles] = useState<SnapshotFileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [selectedBaselineId, setSelectedBaselineId] = useState<number | null>(null);
  const [diff, setDiff] = useState<SnapshotFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // mobile: when a baseline is selected, drop the list to focus the diff
  const [mobileShowDiff, setMobileShowDiff] = useState(false);
  // Project filter: `null` shows files from every project. Built from the
  // distinct `projectId`s observed in the loaded snapshot list. Resets to
  // null on session change to avoid showing an empty filter for a project
  // that no longer has snapshots.
  const [projectFilter, setProjectFilter] = useState<number | null>(null);
  const lastRefreshKey = useRef<number | undefined>(refreshKey);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchSnapshotList(scope, sessionId, { includeClosed: showClosed });
      setFiles(r.files);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, sessionId, showClosed]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // React to live stream pings: refetch list and current diff.
  useEffect(() => {
    if (refreshKey === undefined) return;
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    void reload();
    if (selectedBaselineId != null) {
      void fetchFileDiff(scope, sessionId, selectedBaselineId)
        .then(setDiff)
        .catch(() => { /* swallow — UI shows stale */ });
    }
  }, [refreshKey, reload, scope, sessionId, selectedBaselineId]);

  // Auto-select first active file when nothing selected yet.
  useEffect(() => {
    if (selectedBaselineId != null) return;
    const firstActive = files.find((f) => f.status === 'active');
    if (firstActive) setSelectedBaselineId(firstActive.baselineId);
  }, [files, selectedBaselineId]);

  const loadDiff = useCallback(async (baselineId: number) => {
    setDiffLoading(true);
    try {
      const r = await fetchFileDiff(scope, sessionId, baselineId);
      setDiff(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiffLoading(false);
    }
  }, [scope, sessionId]);

  useEffect(() => {
    if (selectedBaselineId == null) {
      setDiff(null);
      return;
    }
    void loadDiff(selectedBaselineId);
  }, [selectedBaselineId, loadDiff]);

  const handleSelect = useCallback((baselineId: number) => {
    setSelectedBaselineId(baselineId);
    setMobileShowDiff(true);
  }, []);

  const handleAcceptHunk = useCallback(async (fingerprint: string) => {
    if (selectedBaselineId == null) return;
    setBusy(true);
    try {
      await acceptHunk(scope, sessionId, selectedBaselineId, fingerprint);
      await loadDiff(selectedBaselineId);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [scope, sessionId, selectedBaselineId, loadDiff, reload]);

  const handleRevertHunk = useCallback(async (fingerprint: string) => {
    if (selectedBaselineId == null) return;
    setBusy(true);
    try {
      const r = await revertHunk(scope, sessionId, selectedBaselineId, fingerprint);
      if (!r.ok && r.reason) {
        setError(`Could not revert hunk: ${r.reason}`);
      }
      await loadDiff(selectedBaselineId);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [scope, sessionId, selectedBaselineId, loadDiff, reload]);

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
      title: 'Revert file?',
      description: `This will restore ${diff?.baseline.filePath ?? 'this file'} to its session baseline (or delete it if it was created during the session). Cannot be undone from this UI.`,
      confirmLabel: 'Revert file',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await revertFile(scope, sessionId, selectedBaselineId);
      if (!r.ok && r.reason) setError(`Could not revert file: ${r.reason}`);
      await reload();
      setSelectedBaselineId(null);
    } finally {
      setBusy(false);
    }
  }, [scope, sessionId, selectedBaselineId, reload, confirm, diff?.baseline.filePath]);

  const handleAcceptAll = useCallback(async () => {
    const activeCount = files.filter((f) => f.status === 'active').length;
    if (activeCount === 0) return;
    const ok = await confirm({
      title: `Keep all ${activeCount} file change${activeCount === 1 ? '' : 's'}?`,
      description: 'Closes every active snapshot for this session. Files keep their current on-disk contents.',
      confirmLabel: 'Keep all',
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
  }, [files, scope, sessionId, reload, confirm]);

  const handleRevertAll = useCallback(async () => {
    const activeCount = files.filter((f) => f.status === 'active').length;
    if (activeCount === 0) return;
    const ok = await confirm({
      title: `Revert all ${activeCount} file change${activeCount === 1 ? '' : 's'}?`,
      description: 'Restores every active baseline to disk (files created during the session get deleted). Cannot be undone.',
      confirmLabel: 'Revert all',
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
  }, [files, scope, sessionId, reload, confirm]);

  const activeCount = useMemo(() => files.filter((f) => f.status === 'active').length, [files]);
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
              aria-label="Back to file list"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <h2 className="font-medium text-sm truncate">
            Snapshots <span className="text-muted-foreground">({activeCount} active)</span>
          </h2>
          {projects.length > 1 && (
            <select
              className="text-xs bg-background border rounded px-1.5 py-0.5 max-w-[160px]"
              value={projectFilter ?? ''}
              onChange={(e) =>
                setProjectFilter(e.target.value === '' ? null : Number(e.target.value))
              }
              title="Filtrar por projeto"
            >
              <option value="">Todos os projetos</option>
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
            Keep all
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || activeCount === 0}
            onClick={handleRevertAll}
            className="h-7 text-xs px-2"
          >
            Revert all
          </Button>
        </div>
      </div>
      {error && (
        <div className="px-3 py-1.5 text-xs bg-destructive/10 text-destructive border-b">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_1fr]">
        {/* File list — hidden on mobile when a diff is being viewed */}
        <div
          className={cn(
            'border-r min-h-0 flex flex-col',
            mobileShowDiff && 'hidden lg:flex',
          )}
        >
          {loading ? (
            <div className="p-3 text-xs text-muted-foreground">Loading…</div>
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
            'min-h-0 flex flex-col',
            !mobileShowDiff && 'hidden lg:flex',
          )}
        >
          {selectedBaselineId == null ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground italic">
              Select a file to view its diff.
            </div>
          ) : diffLoading || !diff ? (
            <div className="p-3 text-xs text-muted-foreground">Loading diff…</div>
          ) : (
            <SnapshotDiffViewer
              diff={diff}
              onAcceptHunk={handleAcceptHunk}
              onRevertHunk={handleRevertHunk}
              onAcceptFile={handleAcceptFile}
              onRevertFile={handleRevertFile}
              busy={busy}
            />
          )}
        </div>
      </div>
    </div>
  );
}
