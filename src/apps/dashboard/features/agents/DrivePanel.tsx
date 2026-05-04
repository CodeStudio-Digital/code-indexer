/**
 * Drive panel — operator-facing view of the company shared drive.
 *
 * Lists every file the agents have written (or that the human has
 * uploaded), opens any file inline, and lets the operator attach new
 * documents or remove stale ones. Polls every 5s so files written by a
 * running session show up without manual refresh.
 *
 * The drive's scope is a function of the session's template (or the
 * session itself if template-less); the backend resolves it. The panel
 * just renders whatever the API returns.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, RefreshCw, Trash2, Upload, FileText, Eye, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { useApi, apiPost, apiDelete } from '../../hooks/useApi.js';

interface DriveFile {
  id: number;
  scopeKey: string;
  path: string;
  sizeBytes: number;
  mime: string;
  ownerRole: string | null;
  ownerAgentRunId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface DriveListResponse {
  scope: string;
  files: DriveFile[];
}

interface DriveReadResponse {
  meta: DriveFile;
  content: string;
  truncated: boolean;
}

interface DrivePanelProps {
  companySessionId: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function DrivePanel({ companySessionId }: DrivePanelProps) {
  const url = `/company/sessions/${companySessionId}/drive`;
  const list = useApi<DriveListResponse>(url);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewer, setViewer] = useState<DriveReadResponse | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  const [uploadPath, setUploadPath] = useState('');
  const [uploadContent, setUploadContent] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [folderProgress, setFolderProgress] = useState<{
    done: number;
    total: number;
    current: string;
    skipped: { path: string; reason: string }[];
  } | null>(null);

  // 5s polling — same pattern as InboxPanel.
  useEffect(() => {
    const t = setInterval(() => list.refetch(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      setViewer(null);
      setViewerError(null);
      setViewerLoading(true);
      try {
        const params = new URLSearchParams({ path, max_bytes: String(1024 * 1024) });
        const res = await fetch(`/api${url}/file?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as DriveReadResponse;
        setViewer(json);
      } catch (e) {
        setViewerError(e instanceof Error ? e.message : String(e));
      } finally {
        setViewerLoading(false);
      }
    },
    [url],
  );

  const handleUpload = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!uploadPath.trim()) {
        setUploadError('path is required');
        return;
      }
      setUploadBusy(true);
      setUploadError(null);
      try {
        await apiPost(url, { path: uploadPath.trim(), content: uploadContent, mode: 'write' });
        setShowUpload(false);
        setUploadPath('');
        setUploadContent('');
        list.refetch();
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploadBusy(false);
      }
    },
    [url, uploadPath, uploadContent, list],
  );

  const handleFilePick = useCallback(
    async (file: File) => {
      const text = await file.text();
      setUploadPath(file.name);
      setUploadContent(text);
    },
    [],
  );

  // Per-file size cap mirrors the server-side `MAX_WRITE_BYTES` (4MB).
  // Anything heavier is skipped client-side so we don't burn a round-trip.
  const FOLDER_FILE_CAP = 4 * 1024 * 1024;
  // Common binary extensions skipped — drive content is UTF-8 text.
  const BINARY_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'avif',
    'pdf', 'zip', 'tar', 'gz', 'tgz', 'rar', '7z',
    'mp3', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wav', 'ogg', 'flac',
    'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'wasm',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'sqlite', 'db', 'pyc', 'pyo',
  ]);
  function looksBinary(name: string): boolean {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return BINARY_EXT.has(name.slice(dot + 1).toLowerCase());
  }
  function sanitizeRelativePath(rel: string): string {
    // webkitRelativePath uses "/" per spec but normalize defensively;
    // strip any leading "./" or "/" and collapse ".." segments — the
    // server validator rejects these, so it's purely cosmetic before
    // POST and matches what the user expects to see in the listing.
    return rel
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .split('/')
      .filter((seg) => seg !== '..' && seg !== '.')
      .join('/');
  }

  const handleFolderPick = useCallback(
    async (fileList: FileList) => {
      const all = Array.from(fileList);
      const total = all.length;
      const skipped: { path: string; reason: string }[] = [];
      setFolderProgress({ done: 0, total, current: '', skipped: [] });

      for (let i = 0; i < all.length; i++) {
        const f = all[i];
        // webkitRelativePath is non-standard but available in Chromium,
        // Firefox, Safari for `<input webkitdirectory>` selections.
        const rel = sanitizeRelativePath(
          (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
        );
        setFolderProgress((p) => (p ? { ...p, current: rel, done: i } : p));

        if (!rel) {
          skipped.push({ path: f.name, reason: 'empty path after sanitize' });
          continue;
        }
        if (looksBinary(rel)) {
          skipped.push({ path: rel, reason: 'binary file (skipped)' });
          continue;
        }
        if (f.size > FOLDER_FILE_CAP) {
          skipped.push({ path: rel, reason: `>${(FOLDER_FILE_CAP / 1024 / 1024).toFixed(0)}MB cap` });
          continue;
        }
        try {
          const content = await f.text();
          await apiPost(url, { path: rel, content, mode: 'write' });
        } catch (e) {
          skipped.push({ path: rel, reason: e instanceof Error ? e.message : String(e) });
        }
      }

      setFolderProgress({ done: total, total, current: '', skipped });
      list.refetch();
    },
    [url, list],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      if (!confirm(`Delete "${path}" from the shared drive?`)) return;
      try {
        await apiDelete(`${url}?path=${encodeURIComponent(path)}`);
        if (selectedPath === path) {
          setSelectedPath(null);
          setViewer(null);
        }
        list.refetch();
      } catch (e) {
        alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [url, list, selectedPath],
  );

  const files = list.data?.files ?? [];
  const scope = list.data?.scope ?? '';

  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => a.path.localeCompare(b.path)),
    [files],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          {scope ? (
            <Badge variant="outline" className="text-[10px] font-mono">
              scope: {scope}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => list.refetch()}
            title="Refresh"
            className="h-7 w-7 p-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            onClick={() => setShowUpload((v) => !v)}
            className="h-7 gap-1 text-xs"
          >
            <Upload className="h-3.5 w-3.5" />
            {showUpload ? 'Cancel' : 'Attach'}
          </Button>
          <label className="inline-flex">
            <input
              type="file"
              className="hidden"
              onChange={(e) => {
                const fl = e.target.files;
                if (fl && fl.length > 0) {
                  void handleFolderPick(fl);
                  e.target.value = '';
                }
              }}
              {...({ webkitdirectory: '', directory: '', mozdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              multiple
            />
            <Button
              asChild
              size="sm"
              variant="secondary"
              className="h-7 gap-1 text-xs cursor-pointer"
              disabled={folderProgress != null && folderProgress.done < folderProgress.total}
            >
              <span>
                <FolderOpen className="h-3.5 w-3.5" />
                Attach folder
              </span>
            </Button>
          </label>
        </div>
      </div>

      {folderProgress ? (
        <div className="border-b bg-muted/30 px-3 py-2 text-xs space-y-1">
          {folderProgress.done < folderProgress.total ? (
            <div className="flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>
                Uploading {folderProgress.done}/{folderProgress.total}…
              </span>
              <span className="font-mono text-muted-foreground truncate">{folderProgress.current}</span>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span>
                Done — {folderProgress.total - folderProgress.skipped.length}/{folderProgress.total} uploaded
                {folderProgress.skipped.length > 0 ? `, ${folderProgress.skipped.length} skipped` : ''}.
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFolderProgress(null)}
                className="h-6 w-6 p-0"
                title="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {folderProgress.done >= folderProgress.total && folderProgress.skipped.length > 0 ? (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">Show skipped ({folderProgress.skipped.length})</summary>
              <ul className="mt-1 max-h-32 overflow-auto pl-3">
                {folderProgress.skipped.map((s, i) => (
                  <li key={i} className="font-mono">
                    {s.path} — <span className="text-destructive">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {showUpload ? (
        <form onSubmit={handleUpload} className="border-b bg-muted/30 px-3 py-2 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFilePick(f);
              }}
              className="h-8 text-xs flex-1"
            />
            <span className="text-[10px] text-muted-foreground">or fill below</span>
          </div>
          <Input
            placeholder='Path (e.g. "specs/auth.md")'
            value={uploadPath}
            onChange={(e) => setUploadPath(e.target.value)}
            className="h-8 text-xs font-mono"
          />
          <Textarea
            placeholder="File content (UTF-8 text, max 4MB)"
            value={uploadContent}
            onChange={(e) => setUploadContent(e.target.value)}
            className="min-h-[120px] text-xs font-mono"
          />
          {uploadError ? (
            <div className="text-xs text-destructive">{uploadError}</div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setShowUpload(false)}
              className="h-7 text-xs"
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={uploadBusy} className="h-7 text-xs">
              {uploadBusy ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-[minmax(260px,_1fr)_2fr]">
        {/* List */}
        <div className="overflow-auto border-r">
          {list.loading ? (
            <div className="p-3 text-xs text-muted-foreground">Loading…</div>
          ) : list.error ? (
            <div className="p-3 text-xs text-destructive">{list.error}</div>
          ) : sortedFiles.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">
              The drive is empty. Use <strong>Attach</strong> to upload a document, or let the
              agents write to it.
            </div>
          ) : (
            <ul className="divide-y">
              {sortedFiles.map((f) => (
                <li
                  key={f.id}
                  className={`group flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent cursor-pointer ${
                    selectedPath === f.path ? 'bg-accent' : ''
                  }`}
                  onClick={() => void openFile(f.path)}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono truncate">{f.path}</div>
                    <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                      <span>{formatBytes(f.sizeBytes)}</span>
                      {f.ownerRole ? (
                        <span>
                          by <span className="font-mono">{f.ownerRole}</span>
                        </span>
                      ) : null}
                      <span title={f.updatedAt}>{f.updatedAt.replace('T', ' ').replace(/\..*/, '')}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(f.path);
                    }}
                    className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Viewer */}
        <div className="overflow-auto bg-muted/10">
          {!selectedPath ? (
            <div className="p-6 text-xs text-muted-foreground flex items-center gap-2">
              <Eye className="h-4 w-4" /> Select a file on the left to preview its content.
            </div>
          ) : viewerLoading ? (
            <div className="p-3 text-xs text-muted-foreground">Loading…</div>
          ) : viewerError ? (
            <div className="p-3 text-xs text-destructive">{viewerError}</div>
          ) : viewer ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b px-3 py-2 bg-background">
                <div className="text-xs font-mono truncate">{viewer.meta.path}</div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    {formatBytes(viewer.meta.sizeBytes)}
                    {viewer.truncated ? ' (truncated)' : ''}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSelectedPath(null);
                      setViewer(null);
                    }}
                    className="h-6 w-6 p-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <pre className="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-words">
                {viewer.content}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
