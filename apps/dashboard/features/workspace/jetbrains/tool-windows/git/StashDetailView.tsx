/**
 * Stash preview surface — opened in the editor content area when the
 * user clicks a stash in the Stash tab. Shows the stash's message +
 * branch + date and the files it captured; clicking a file opens that
 * file's diff as a normal editor tab. Read-only: apply/pop/drop live in
 * the Stash list (where the list can refresh after the mutation).
 *
 * Mirrors the commit preview (`CommitDetailPanel`) so a stash reads the
 * same as any other snapshot in the IDE.
 */

import { useEffect, useState } from 'react';
import { Archive, ClipboardCopy, Loader2 } from 'lucide-react';
import { apiCall } from '../../../../../lib/api-client.js';
import { useWorkspaceStore, type OpenGitStash } from '../../../../../state/workspace.js';
import { toast } from '../../../../../components/ui/prompt-dialog.js';
import { formatDate } from './CommitRow.js';
import { ChangedFilesList, type ChangedFile } from './ChangedFilesList.js';

interface GitStashDetail {
  ref: string;
  shortSha: string;
  branch: string | null;
  message: string;
  date: string;
  files: ChangedFile[];
}

export function StashDetailView({ tab }: { tab: OpenGitStash }) {
  const { projectId, stashRef } = tab;
  const [detail, setDetail] = useState<GitStashDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const openDiff = useWorkspaceStore((s) => s.openDiff);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiCall<GitStashDetail>('projectGit.stashDetail', { projectId, ref: stashRef })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, stashRef]);

  const openFile = async (f: ChangedFile) => {
    try {
      const r = await apiCall<{ patch: string }>('projectGit.stashFileDiff', {
        projectId,
        ref: stashRef,
        path: f.path,
      });
      const base = f.path.split('/').pop() ?? f.path;
      openDiff({
        kind: 'diff',
        projectId,
        path: `stashfile:${stashRef}:${f.path}`,
        title: `${stashRef} · ${base}`,
        patch: r.patch,
        source: 'git-stash',
      });
    } catch (e) {
      toast.error('Failed to open file diff', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (loading) {
    return (
      <div className="h-full grid place-items-center text-muted-foreground bg-background">
        <Loader2 className="h-4 w-4 animate-spin opacity-60" />
      </div>
    );
  }
  if (error) {
    return <div className="p-3 text-[11px] text-destructive bg-background h-full">{error}</div>;
  }
  if (!detail) return null;

  // The auto "WIP on <branch>:" prefix is redundant once we show the
  // branch as its own chip — strip it for the headline.
  const headline = detail.message.replace(/^(?:WIP on|On)\s+[^:]+:\s*/, '').trim() || '(no message)';

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="shrink-0 px-3 py-2 border-b space-y-1">
        <div className="flex items-center gap-2 text-[11px]">
          <Archive className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          <span className="font-mono text-muted-foreground">{detail.shortSha}</span>
          <button
            type="button"
            className="h-4 w-4 grid place-items-center rounded-sm text-muted-foreground/70 hover:text-foreground hover:bg-muted"
            title="Copy stash ref"
            onClick={() => void navigator.clipboard.writeText(detail.ref).catch(() => undefined)}
          >
            <ClipboardCopy className="h-3 w-3" />
          </button>
          {detail.branch && (
            <span className="text-[10px] text-muted-foreground/70 truncate">on {detail.branch}</span>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground/60">{formatDate(detail.date)}</span>
        </div>
        <div className="text-[12px] font-medium leading-snug">{headline}</div>
      </div>

      <div className="shrink-0 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70 border-b">
        {detail.files.length} file{detail.files.length === 1 ? '' : 's'} stashed
      </div>
      <ChangedFilesList files={detail.files} onOpenFile={(f) => void openFile(f)} />
    </div>
  );
}
