import { useCallback, useEffect, useRef, useState } from 'react';
import { apiCall } from '../../../../../lib/api-client.js';
import type { Commit } from './CommitRow.js';
import type { GitLogPage } from '@mcp/api-bus';

const DEFAULT_PAGE_SIZE = 80;

interface PaginatedGitLogOptions {
  enabled?: boolean;
  projectId: number;
  repoPath?: string;
  branch?: string;
  all?: boolean;
  path?: string;
  /** External revision token; a changed ref invalidates the loaded pages. */
  reloadKey?: number | string;
  pageSize?: number;
}

interface PaginatedGitLog {
  commits: Commit[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/** Cursor pagination over server-pinned ref tips, with stale-request protection. */
export function usePaginatedGitLog({
  enabled = true,
  projectId,
  repoPath,
  branch,
  all,
  path,
  reloadKey,
  pageSize = DEFAULT_PAGE_SIZE,
}: PaginatedGitLogOptions): PaginatedGitLog {
  const size = Math.max(1, Math.min(500, Math.trunc(pageSize)));
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const requestRef = useRef(0);
  const snapshotRef = useRef<string | null>(null);
  const cursorRef = useRef<string | null>(null);

  const requestPage = useCallback(async (append: boolean) => {
    const requestId = ++requestRef.current;
    let shouldAppend = append;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const readPage = (continued: boolean) => apiCall<GitLogPage>('projectGit.logPage', {
        projectId,
        repoPath,
        branch,
        all,
        path,
        pageSize: size,
        ...(continued && snapshotRef.current ? { snapshotId: snapshotRef.current, cursor: cursorRef.current } : {}),
      });
      let page: GitLogPage;
      try {
        page = await readPage(append);
      } catch (cause) {
        const err = cause as Error & { status?: number };
        if (!append || err.status !== 410) throw cause;
        page = await readPage(false);
        shouldAppend = false;
      }
      if (requestId !== requestRef.current) return;
      snapshotRef.current = page.snapshotId;
      cursorRef.current = page.nextCursor;
      setHasMore(page.nextCursor !== null);
      if (!shouldAppend) {
        setCommits(page.commits);
        return;
      }
      // Snapshot refs are immutable, and SHA de-duplication remains a defensive
      // guard for merge graphs reachable from multiple pinned tips.
      setCommits((current) => {
        const seen = new Set(current.map((commit) => commit.sha));
        return [...current, ...page.commits.filter((commit) => !seen.has(commit.sha))];
      });
    } catch (cause) {
      if (requestId === requestRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [all, branch, path, projectId, repoPath, size]);

  const reload = useCallback(() => requestPage(false), [requestPage]);
  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;
    await requestPage(true);
  }, [hasMore, loading, loadingMore, requestPage]);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload, reloadKey]);

  return { commits, loading, loadingMore, error, hasMore, reload, loadMore };
}
