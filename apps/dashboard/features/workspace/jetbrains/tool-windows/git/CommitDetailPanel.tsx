/**
 * Commit preview — the right-hand pane of the Git Log surface. Shows a
 * selected commit's metadata + full message + the files it touched.
 * Clicking a file opens its diff as a normal editor tab (reusing the
 * workspace store's `openDiff`), matching how the Changes tab behaves.
 */

import { useEffect, useState } from 'react';
import { ClipboardCopy, GitCommit, Loader2 } from 'lucide-react';
import { apiCall } from '../../../../../lib/api-client.js';
import { useWorkspaceStore } from '../../../../../state/workspace.js';
import { toast } from '../../../../../components/ui/prompt-dialog.js';
import { formatDate } from './CommitRow.js';
import { ChangedFilesList, type ChangedFile } from './ChangedFilesList.js';

interface GitCommitDetail {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  parents: string[];
  files: ChangedFile[];
}

interface CommitDetailPanelProps {
  projectId: number;
  sha: string | null;
}

export function CommitDetailPanel({ projectId, sha }: CommitDetailPanelProps) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openDiff = useWorkspaceStore((s) => s.openDiff);

  useEffect(() => {
    if (!sha) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiCall<GitCommitDetail>('projectGit.commitDetail', { projectId, sha })
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
  }, [projectId, sha]);

  const openFile = async (f: ChangedFile) => {
    if (!detail) return;
    try {
      const r = await apiCall<{ patch: string }>('projectGit.commitFileDiff', {
        projectId,
        sha: detail.sha,
        path: f.path,
      });
      const base = f.path.split('/').pop() ?? f.path;
      openDiff({
        kind: 'diff',
        projectId,
        path: `gitshow:${detail.sha}:${f.path}`,
        title: `${detail.shortSha} · ${base}`,
        patch: r.patch,
        source: 'other',
      });
    } catch (e) {
      toast.error('Failed to open file diff', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (!sha) {
    return (
      <div className="h-full grid place-items-center text-center text-muted-foreground gap-2 px-6">
        <GitCommit className="h-5 w-5 opacity-40" />
        <p className="text-[11.5px]">Select a commit to preview it.</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="h-full grid place-items-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin opacity-60" />
      </div>
    );
  }
  if (error) {
    return <div className="p-3 text-[11px] text-destructive">{error}</div>;
  }
  if (!detail) return null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-3 py-2 border-b space-y-1">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-mono text-muted-foreground">{detail.shortSha}</span>
          <button
            type="button"
            className="h-4 w-4 grid place-items-center rounded-sm text-muted-foreground/70 hover:text-foreground hover:bg-muted"
            title="Copy full SHA"
            onClick={() => void navigator.clipboard.writeText(detail.sha).catch(() => undefined)}
          >
            <ClipboardCopy className="h-3 w-3" />
          </button>
          {detail.parents.length > 1 && (
            <span className="text-[10px] text-muted-foreground/70">merge</span>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground/60">
            {formatDate(detail.date)}
          </span>
        </div>
        <div className="text-[12px] font-medium leading-snug">{detail.subject}</div>
        {detail.body && (
          <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed max-h-32 overflow-y-auto">
            {detail.body}
          </pre>
        )}
        <div className="text-[10.5px] text-muted-foreground/80 truncate">
          {detail.author} &lt;{detail.authorEmail}&gt;
        </div>
      </div>

      <div className="shrink-0 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70 border-b">
        {detail.files.length} file{detail.files.length === 1 ? '' : 's'} changed
      </div>
      <ChangedFilesList files={detail.files} onOpenFile={(f) => void openFile(f)} />
    </div>
  );
}
