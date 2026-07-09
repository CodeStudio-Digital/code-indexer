/**
 * SFTP browser — navigate a host's remote filesystem, make/rename/delete
 * entries, and transfer files to/from local disk with live progress. Transfers
 * run entirely in main (remote ↔ local disk); the renderer streams progress.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, File as FileIcon, ArrowUp, RefreshCw, FolderPlus, Upload, Download, SquarePen, Pencil, Trash2, Loader2, X } from 'lucide-react';
import type { SftpEntry } from '@mcp/api-bus';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../components/ui/select.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { useWorkspaceLayout } from '../../../state/workspace-layout.js';
import { prompt, confirm, toast } from '../../../components/ui/prompt-dialog.js';
import {
  resolveSpecFromHost,
  sftpList,
  sftpListWithTrust,
  sftpRealpath,
  sftpMkdir,
  sftpRename,
  sftpRemove,
  sftpClose,
  sftpDownload,
  sftpUpload,
  sftpCancel,
  sftpReadFile,
  pickLocalFiles,
  pickSavePath,
  type NeedTrust,
  findHostByKey,
  sshHostKey,
} from '../api.js';
import type { SshConnectSpec } from '@mcp/api-bus';
import type { SshHost, SshIdentity } from '../types.js';

interface SftpBrowserProps {
  projectId: number;
  hosts: SshHost[];
  identities: SshIdentity[];
  onNeedTrust: NeedTrust;
}

interface Transfer {
  id: string;
  name: string;
  dir: 'up' | 'down';
  transferred: number;
  total: number;
  done?: boolean;
  error?: string;
  cancelled?: boolean;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const posixDir = (p: string): string => {
  if (p === '/' || !p.includes('/')) return '/';
  const cut = p.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
  return cut || '/';
};
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
/** Server-supplied filenames are untrusted: keep only the last path segment and strip
 *  leading dots so a hostile SFTP server can't pre-seed a traversal-y save default. */
const safeBaseName = (name: string): string => {
  const last = name.split(/[\\/]/).pop() ?? '';
  return last.replace(/^\.+/, '').trim() || 'download';
};
const joinPosix = (dir: string, name: string): string => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

export function SftpBrowser({ projectId, hosts, identities, onNeedTrust }: SftpBrowserProps) {
  const { t } = useTranslation('ssh');
  const [hostId, setHostId] = useState('');
  const [spec, setSpec] = useState<SshConnectSpec | null>(null);
  const [cwd, setCwd] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  /** Path of the entry with an in-flight per-row action (open/rename/delete) → shows a spinner. */
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const specRef = useRef<SshConnectSpec | null>(null);
  specRef.current = spec;

  const fail = useCallback((e: unknown) => setError(t('sftp.loadError', { reason: e instanceof Error ? e.message : String(e) })), [t]);

  const navigate = useCallback(
    async (path: string) => {
      const s = specRef.current;
      if (!s) return;
      setLoading(true);
      setError(null);
      try {
        setEntries(await sftpList(s, path));
        setCwd(path);
      } catch (e) {
        fail(e);
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  // Connect + open home when a host is chosen; close the previous SFTP session.
  useEffect(() => {
    const prev = specRef.current;
    if (prev) void sftpClose(prev.hostId).catch(() => undefined);
    setSpec(null);
    setEntries([]);
    setCwd('/');
    if (!hostId) return;
    const host = findHostByKey(hosts, hostId);
    if (!host) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const s = await resolveSpecFromHost(host, hosts, identities);
        if (cancelled) return;
        specRef.current = s;
        setSpec(s);
        const home = await sftpListWithTrust(s, '.', onNeedTrust); // TOFU on the first op
        const homePath = await sftpRealpath(s, '.');
        if (cancelled) return;
        setEntries(home);
        setCwd(homePath);
      } catch (e) {
        if (!cancelled) fail(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  const updateTransfer = useCallback((id: string, patch: Partial<Transfer>) => {
    setTransfers((ts) => ts.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  const runTransfer = useCallback(
    async (tf: Transfer, stream: AsyncIterable<{ type: string; transferred?: number; total?: number; message?: string }>) => {
      setTransfers((ts) => [...ts.filter((x) => x.id !== tf.id), tf]);
      const label = tf.dir === 'up' ? t('sftp.uploaded', { name: tf.name }) : t('sftp.downloaded', { name: tf.name });
      const isCancel = (msg?: string) => msg === 'transfer cancelled';
      try {
        for await (const p of stream) {
          if (p.type === 'progress') updateTransfer(tf.id, { transferred: p.transferred ?? 0, total: p.total ?? tf.total });
          else if (p.type === 'done') { updateTransfer(tf.id, { done: true }); toast.success(label); }
          else if (p.type === 'error') {
            const cancelled = isCancel(p.message);
            updateTransfer(tf.id, { done: true, cancelled, error: cancelled ? undefined : p.message });
            if (!cancelled) toast.error(t('sftp.actionError', { reason: p.message ?? '' }));
          }
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const cancelled = isCancel(reason);
        updateTransfer(tf.id, { done: true, cancelled, error: cancelled ? undefined : reason });
        if (!cancelled) toast.error(t('sftp.actionError', { reason }));
      }
      // Auto-clear finished transfers after a moment.
      setTimeout(() => setTransfers((ts) => ts.filter((x) => x.id !== tf.id)), 4000);
    },
    [updateTransfer, t],
  );

  /** Cancel an in-flight transfer (ends its channel in main; the stream then errors out as cancelled). */
  const cancelTransfer = useCallback((id: string) => {
    setTransfers((ts) => ts.map((x) => (x.id === id ? { ...x, cancelled: true } : x)));
    void sftpCancel(id).catch(() => undefined);
  }, []);

  const download = useCallback(
    async (entry: SftpEntry) => {
      const s = specRef.current;
      if (!s) return;
      const local = await pickSavePath(safeBaseName(entry.name));
      if (!local) return;
      const id = `down:${entry.path}`;
      await runTransfer(
        { id, name: entry.name, dir: 'down', transferred: 0, total: entry.size },
        sftpDownload(s, entry.path, local, id),
      );
    },
    [runTransfer],
  );

  // Open a remote text file in the Monaco editor: fetch its bytes into an
  // in-memory tab whose save re-uploads over SFTP and whose close discards it.
  // While fetching, the row spins; on success we surface the editor (collapse the
  // bottom panel) so the user lands ON the file they just opened.
  const editRemote = useCallback(
    async (entry: SftpEntry) => {
      const s = specRef.current;
      if (!s || entry.type === 'dir') return;
      setError(null);
      setBusyPath(entry.path);
      try {
        const { content } = await sftpReadFile(s, entry.path);
        const host = findHostByKey(hosts, hostId);
        useWorkspaceStore.getState().openSftpFile({
          kind: 'sftp',
          projectId,
          path: `sftp:${s.hostId}:${entry.path}`,
          remotePath: entry.path,
          spec: s,
          hostLabel: host?.label ?? s.host,
          content,
          dirty: false,
        });
        // Move the user to the editor: collapse the bottom panel so the freshly
        // opened (and focused) remote file takes the full editor area.
        useWorkspaceLayout.getState().setActiveBottom(null);
      } catch (e) {
        // Open/read failure (too-large / binary / not-utf8 / read error) — NOT a
        // listing failure, so don't reuse the navigation `fail` helper's text.
        const reason = e instanceof Error ? e.message : String(e);
        setError(t('sftp.editError', { name: entry.name, reason }));
        toast.error(t('sftp.editError', { name: entry.name, reason }));
      } finally {
        setBusyPath(null);
      }
    },
    [projectId, hosts, hostId, t],
  );

  const upload = useCallback(async () => {
    const s = specRef.current;
    if (!s) return;
    const files = await pickLocalFiles();
    for (const local of files) {
      const name = baseName(local);
      const id = `up:${local}`;
      await runTransfer(
        { id, name, dir: 'up', transferred: 0, total: 0 },
        sftpUpload(s, local, joinPosix(cwd, name), id),
      );
    }
    void navigate(cwd);
  }, [cwd, runTransfer, navigate]);

  const mkdir = useCallback(async () => {
    const s = specRef.current;
    if (!s) return;
    const name = await prompt({ title: t('sftp.newFolder'), placeholder: t('sftp.newFolderPrompt'), confirmLabel: t('sftp.newFolder'), cancelLabel: t('dialog.cancel') });
    if (!name?.trim()) return;
    try {
      await sftpMkdir(s, joinPosix(cwd, name.trim()));
      toast.success(t('sftp.folderCreated', { name: name.trim() }));
      void navigate(cwd);
    } catch (e) {
      toast.error(t('sftp.actionError', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }, [cwd, navigate, t]);

  const rename = useCallback(
    async (entry: SftpEntry) => {
      const s = specRef.current;
      if (!s) return;
      const next = await prompt({ title: t('sftp.rename'), defaultValue: entry.name, placeholder: t('sftp.renamePrompt'), confirmLabel: t('sftp.rename'), cancelLabel: t('dialog.cancel') });
      if (!next?.trim() || next.trim() === entry.name) return;
      setBusyPath(entry.path);
      try {
        await sftpRename(s, entry.path, joinPosix(cwd, next.trim()));
        toast.success(t('sftp.renamed', { name: next.trim() }));
        void navigate(cwd);
      } catch (e) {
        toast.error(t('sftp.actionError', { reason: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusyPath(null);
      }
    },
    [cwd, navigate, t],
  );

  const remove = useCallback(
    async (entry: SftpEntry) => {
      const s = specRef.current;
      if (!s) return;
      const ok = await confirm({ title: t('sftp.delete'), description: t('sftp.deleteConfirm', { name: entry.name }), confirmLabel: t('sftp.delete'), cancelLabel: t('dialog.cancel'), tone: 'destructive' });
      if (!ok) return;
      setBusyPath(entry.path);
      try {
        await sftpRemove(s, entry.path, entry.type === 'dir');
        toast.success(t('sftp.deleted', { name: entry.name }));
        void navigate(cwd);
      } catch (e) {
        toast.error(t('sftp.actionError', { reason: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusyPath(null);
      }
    },
    [cwd, navigate, t],
  );

  const iconBtn = 'rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40';

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="h-8 shrink-0 border-b flex items-center gap-1 px-2">
        <div className="w-[180px] shrink-0">
          <Select value={hostId} onValueChange={setHostId}>
            <SelectTrigger className="h-6 text-xs"><SelectValue placeholder={t('sftp.selectHost')} /></SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={sshHostKey(h)} value={sshHostKey(h)}>{h.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <button type="button" aria-label={t('sftp.up')} className={iconBtn} disabled={!spec || cwd === '/'} onClick={() => void navigate(posixDir(cwd))}>
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('sftp.refresh')} className={iconBtn} disabled={!spec} onClick={() => void navigate(cwd)}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('sftp.newFolder')} className={iconBtn} disabled={!spec} onClick={() => void mkdir()}>
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('sftp.upload')} className={iconBtn} disabled={!spec} onClick={() => void upload()}>
          <Upload className="h-3.5 w-3.5" />
        </button>
        <span className="ml-1 truncate font-mono text-[11px] text-muted-foreground" title={cwd}>{cwd}</span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-auto" />}
      </div>

      {error && <div className="px-2 py-1 text-[10px] text-red-400 border-b bg-red-500/10 shrink-0">{error}</div>}

      {/* Entries */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!spec && <div className="grid place-items-center h-full text-xs text-muted-foreground">{t('sftp.selectHost')}</div>}
        {spec && entries.length === 0 && !loading && (
          <div className="grid place-items-center h-full text-xs text-muted-foreground">{t('sftp.empty')}</div>
        )}
        {entries.map((e) => (
          <div
            key={e.path}
            className="group flex items-center gap-2 px-3 py-1 text-xs hover:bg-muted cursor-default"
            onDoubleClick={() => e.type === 'dir' && void navigate(e.path)}
          >
            {e.type === 'dir' ? (
              <Folder className="h-3.5 w-3.5 text-blue-400 shrink-0" />
            ) : (
              <FileIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <button
              type="button"
              className="truncate flex-1 text-left hover:underline"
              onClick={() => (e.type === 'dir' ? void navigate(e.path) : void editRemote(e))}
            >
              {e.name}
            </button>
            <span className="text-muted-foreground tabular-nums shrink-0 w-16 text-right">
              {e.type === 'dir' ? '' : fmtBytes(e.size)}
            </span>
            {busyPath === e.path ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0 mr-0.5" />
            ) : (
              <>
                {e.type !== 'dir' && (
                  <button type="button" aria-label={t('sftp.edit')} title={t('sftp.edit')} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5" onClick={() => void editRemote(e)}>
                    <SquarePen className="h-3 w-3" />
                  </button>
                )}
                {e.type !== 'dir' && (
                  <button type="button" aria-label={t('sftp.download')} title={t('sftp.download')} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5" onClick={() => void download(e)}>
                    <Download className="h-3 w-3" />
                  </button>
                )}
                <button type="button" aria-label={t('sftp.rename')} title={t('sftp.rename')} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5" onClick={() => void rename(e)}>
                  <Pencil className="h-3 w-3" />
                </button>
                <button type="button" aria-label={t('sftp.delete')} title={t('sftp.delete')} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 hover:text-red-500" onClick={() => void remove(e)}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Transfers */}
      {transfers.length > 0 && (
        <div className="shrink-0 border-t max-h-28 overflow-y-auto">
          {transfers.map((tf) => {
            const pct = tf.total > 0 ? Math.min(100, Math.round((tf.transferred / tf.total) * 100)) : 0;
            return (
              <div key={tf.id} className="px-3 py-1 text-[11px] flex items-center gap-2">
                {tf.dir === 'up' ? <Upload className="h-3 w-3 shrink-0" /> : <Download className="h-3 w-3 shrink-0" />}
                <span className="truncate flex-1">{tf.name}</span>
                {tf.cancelled ? (
                  <span className="text-muted-foreground shrink-0">{t('sftp.cancelled')}</span>
                ) : tf.error ? (
                  <span className="text-red-500 shrink-0">{tf.error}</span>
                ) : (
                  <span className="text-muted-foreground tabular-nums shrink-0">{tf.done ? '100%' : `${pct}%`}</span>
                )}
                {!tf.done && !tf.cancelled && (
                  <button
                    type="button"
                    aria-label={t('sftp.cancel')}
                    title={t('sftp.cancel')}
                    className="shrink-0 p-0.5 text-muted-foreground hover:text-red-500"
                    onClick={() => cancelTransfer(tf.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
