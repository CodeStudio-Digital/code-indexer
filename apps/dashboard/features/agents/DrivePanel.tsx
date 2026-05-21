/**
 * Drive panel — operator-facing view of the company shared drive.
 *
 * Lists every file the agents have written (or that the human has
 * uploaded), opens any file inline, and lets the operator attach new
 * documents or remove stale ones.
 *
 * Phase 2: the file list lives in the `driveSlice` and is kept fresh by
 * SSE `drive.file_added | updated | deleted` events. The legacy 5 s poll
 * stays only as a fallback for when the SSE stream is disconnected (the
 * orchestrator is dormant or the user just opened the tab). Operator
 * mutations always refetch right after the request so the UI never lags
 * behind a manual action regardless of connection state.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Code2, Download, Eye, FileText, FolderOpen, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiPost, apiDelete } from '../../hooks/useApi.js';
import { useResizableWidth } from '../../hooks/useResizableWidth.js';
import { cn } from '../../lib/utils.js';
import { MarkdownView } from '../builder/preview/files/viewer/MarkdownView.js';
import {
  selectDrive,
  selectStream,
  useCompanyStore,
} from '../../state/company/index.js';
import type { DriveFileMeta } from '../../state/company/driveSlice.js';

type ViewMode = 'raw' | 'preview';

function inferKind(path: string): 'md' | 'html' | 'pdf' | 'other' {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}

function downloadAsFile(name: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // The drive paths may include nested directories; pick the leaf.
  a.download = name.split('/').pop() || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke to give the browser time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type DriveFile = DriveFileMeta;

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
  const { t } = useTranslation('agents');
  const url = `/company/sessions/${companySessionId}/drive`;

  // ─── Slice subscription ──────────────────────────────────────
  const slot = useCompanyStore((s) => selectDrive(s, companySessionId));
  const driveHydrate = useCompanyStore((s) => s.driveHydrate);
  const driveSetLoading = useCompanyStore((s) => s.driveSetLoading);
  const driveSetError = useCompanyStore((s) => s.driveSetError);
  const connected = useCompanyStore((s) => selectStream(s, companySessionId).connected);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewer, setViewer] = useState<DriveReadResponse | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');

  // Drag-resizable file list. Anchored to the left edge — drag RIGHT to
  // grow. Width persists per-user so frequent operators don't re-tune
  // every session.
  const listSizer = useResizableWidth({
    defaultWidth: 320,
    minWidth: 200,
    maxWidth: 720,
    storageKey: 'agents.drive.listWidth',
    anchor: 'left',
  });

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

  // Fetch+hydrate from REST. Called on mount and as the manual refresh
  // action; mutations don't need to call this because the backend SSE
  // event (`drive.file_added | updated | deleted`) keeps the slice up
  // to date. The poll fallback below uses this same loader.
  const refresh = useCallback(async () => {
    driveSetLoading(companySessionId, true);
    driveSetError(companySessionId, null);
    try {
      const res = await fetch(`/api${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as DriveListResponse;
      driveHydrate(companySessionId, body.scope, body.files);
    } catch (e) {
      driveSetError(companySessionId, e instanceof Error ? e.message : String(e));
    } finally {
      driveSetLoading(companySessionId, false);
    }
  }, [companySessionId, url, driveHydrate, driveSetLoading, driveSetError]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll fallback — only fires while the SSE stream is disconnected. As
  // soon as the stream reconnects, the slice resumes receiving live
  // events and the interval clears itself.
  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [connected, refresh]);

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
        // SSE `drive.file_added | updated` updates the slice when
        // connected; refresh keeps the UI tight even when the orchestrator
        // is dormant (no publisher to fire the event).
        void refresh();
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploadBusy(false);
      }
    },
    [url, uploadPath, uploadContent, refresh],
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
      void refresh();
    },
    [url, refresh],
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
        void refresh();
      } catch (e) {
        alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [url, refresh, selectedPath],
  );

  // Reset to preview mode each time the user opens a different file —
  // markdown rendering is the more useful default, the raw toggle is
  // there for inspecting front-matter / verifying agent output.
  useEffect(() => {
    setViewMode('preview');
  }, [selectedPath]);

  const files = useMemo(() => Array.from(slot.files.values()), [slot.files]);
  const scope = slot.scope ?? '';

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
            {t('drive.fileCount', { count: files.length })}
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
            onClick={() => void refresh()}
            title={t('common.refresh', 'Refresh')}
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
            {showUpload ? t('common.cancel', 'Cancel') : t('drive.attach', 'Attach')}
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
                {t('drive.attachFolder', 'Attach folder')}
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

      <div className="flex-1 overflow-hidden flex">
        {/* List */}
        <div
          style={{ width: listSizer.width }}
          className="overflow-auto border-r flex-shrink-0"
        >
          {slot.loading && !slot.initialized ? (
            <div className="p-3 text-xs text-muted-foreground">{t('common.loading', 'Loading…')}</div>
          ) : slot.error ? (
            <div className="p-3 text-xs text-destructive">{slot.error}</div>
          ) : sortedFiles.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">
              {t('drive.empty', 'The drive is empty. Use Attach to upload a document, or let the agents write to it.')}
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
                    title={t('common.delete', 'Delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={listSizer.startResize}
          className={cn(
            'w-1 cursor-col-resize shrink-0 transition-colors',
            listSizer.resizing ? 'bg-primary/60' : 'bg-border hover:bg-primary/40',
          )}
          title={t('common.resizeHandle', 'Drag to resize')}
        />

        {/* Viewer. `min-w-0` makes the flex item respect the column
            width so long lines inside the <pre> trigger horizontal
            scroll instead of pushing the panel wider. */}
        <div className="flex-1 min-w-0 overflow-hidden bg-muted/10">
          {!selectedPath ? (
            <div className="p-6 text-xs text-muted-foreground flex items-center gap-2">
              <Eye className="h-4 w-4" /> {t('drive.selectFile', 'Select a file on the left to view it.')}
            </div>
          ) : viewerLoading ? (
            <div className="p-3 text-xs text-muted-foreground">{t('common.loading', 'Loading…')}</div>
          ) : viewerError ? (
            <div className="p-3 text-xs text-destructive">{viewerError}</div>
          ) : viewer ? (
            <DriveFileViewer
              data={viewer}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onClose={() => {
                setSelectedPath(null);
                setViewer(null);
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface DriveFileViewerProps {
  data: DriveReadResponse;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  onClose: () => void;
}

/**
 * Viewer for a single drive file. Honors the user's `viewMode` choice
 * for content with a rendered representation (markdown, html) and
 * always falls back to raw text otherwise.
 *
 * The download button creates a `Blob` of the displayed content and
 * triggers a save with the original leaf name. Works for any text
 * file — PDFs aren't stored as text so they go through this same
 * "save the raw bytes" path.
 */
function DriveFileViewer({ data, viewMode, onViewModeChange, onClose }: DriveFileViewerProps) {
  const { t } = useTranslation('agents');
  const kind = inferKind(data.meta.path);
  const canPreview = kind === 'md' || kind === 'html';
  const effectiveMode: ViewMode = canPreview ? viewMode : 'raw';

  const mime =
    kind === 'md' ? 'text/markdown;charset=utf-8'
    : kind === 'html' ? 'text/html;charset=utf-8'
    : kind === 'pdf' ? 'application/pdf'
    : 'text/plain;charset=utf-8';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 bg-background">
        <div className="text-xs font-mono truncate flex-1" title={data.meta.path}>
          {data.meta.path}
        </div>
        {canPreview && (
          <div className="inline-flex rounded-md border overflow-hidden text-[11px]">
            <button
              type="button"
              onClick={() => onViewModeChange('preview')}
              className={cn(
                'px-2 py-0.5 inline-flex items-center gap-1 transition-colors',
                effectiveMode === 'preview' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60',
              )}
              title={t('drive.renderPreview', 'Render preview')}
            >
              <Eye className="h-3 w-3" /> {t('common.preview', 'Preview')}
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('raw')}
              className={cn(
                'px-2 py-0.5 inline-flex items-center gap-1 transition-colors border-l',
                effectiveMode === 'raw' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60',
              )}
              title={t('drive.showRaw', 'Show raw text')}
            >
              <Code2 className="h-3 w-3" /> {t('common.raw', 'Raw')}
            </button>
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => downloadAsFile(data.meta.path, data.content, mime)}
          className="h-7 px-2 text-xs gap-1"
          title={t('drive.downloadFile', 'Download file')}
        >
          <Download className="h-3.5 w-3.5" /> {t('common.download', 'Download')}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {data.meta.sizeBytes < 1024
            ? `${data.meta.sizeBytes} B`
            : data.meta.sizeBytes < 1024 * 1024
              ? `${(data.meta.sizeBytes / 1024).toFixed(1)} KB`
              : `${(data.meta.sizeBytes / 1024 / 1024).toFixed(2)} MB`}
          {data.truncated ? ' (truncated)' : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          className="h-6 w-6 p-0"
          title={t('common.close', 'Close')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {kind === 'pdf' ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
          <FileText className="h-8 w-8 opacity-40" />
          <span>{t('drive.pdfDownloadOnly', 'PDFs cannot be previewed inline — use the Download button.')}</span>
        </div>
      ) : kind === 'html' && effectiveMode === 'preview' ? (
        // `srcdoc` avoids needing a server-served URL; the sandbox attrs
        // strip script/popup execution so a malicious agent-written page
        // can't reach into the dashboard.
        <iframe
          srcDoc={data.content}
          sandbox=""
          className="flex-1 w-full bg-white border-0"
          title={data.meta.path}
        />
      ) : kind === 'md' && effectiveMode === 'preview' ? (
        <MarkdownView text={data.content} />
      ) : (
        <pre className="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre">
          {data.content}
        </pre>
      )}
    </div>
  );
}
