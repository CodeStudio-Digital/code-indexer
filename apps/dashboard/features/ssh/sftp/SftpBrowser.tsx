/**
 * SFTP browser — navigate a host's remote filesystem, make/rename/delete
 * entries, and transfer files to/from local disk with live progress. Transfers
 * run entirely in main (remote ↔ local disk); the renderer streams progress.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, File as FileIcon, ArrowUp, RefreshCw, FolderPlus, Upload, Download, Pencil, Trash2, Loader2 } from 'lucide-react';
import type { SftpEntry } from '@mcp/api-bus';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../components/ui/select.js';
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
  pickLocalFiles,
  pickSavePath,
  type NeedTrust,
} from '../api.js';
import type { SshConnectSpec } from '@mcp/api-bus';
import type { SshHost, SshIdentity } from '../types.js';

interface SftpBrowserProps {
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

export function SftpBrowser({ hosts, identities, onNeedTrust }: SftpBrowserProps) {
  const { t } = useTranslation('ssh');
  const [hostId, setHostId] = useState('');
  const [spec, setSpec] = useState<SshConnectSpec | null>(null);
  const [cwd, setCwd] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);

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
    const host = hosts.find((h) => String(h.id) === hostId);
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
      try {
        for await (const p of stream) {
          if (p.type === 'progress') updateTransfer(tf.id, { transferred: p.transferred ?? 0, total: p.total ?? tf.total });
          else if (p.type === 'done') updateTransfer(tf.id, { done: true });
          else if (p.type === 'error') updateTransfer(tf.id, { done: true, error: p.message });
        }
      } catch (e) {
        updateTransfer(tf.id, { done: true, error: e instanceof Error ? e.message : String(e) });
      }
      // Auto-clear finished transfers after a moment.
      setTimeout(() => setTransfers((ts) => ts.filter((x) => x.id !== tf.id)), 4000);
    },
    [updateTransfer],
  );

  const download = useCallback(
    async (entry: SftpEntry) => {
      const s = specRef.current;
      if (!s) return;
      const local = await pickSavePath(safeBaseName(entry.name));
      if (!local) return;
      await runTransfer(
        { id: `down:${entry.path}`, name: entry.name, dir: 'down', transferred: 0, total: entry.size },
        sftpDownload(s, entry.path, local),
      );
    },
    [runTransfer],
  );

  const upload = useCallback(async () => {
    const s = specRef.current;
    if (!s) return;
    const files = await pickLocalFiles();
    for (const local of files) {
      const name = baseName(local);
      await runTransfer(
        { id: `up:${local}`, name, dir: 'up', transferred: 0, total: 0 },
        sftpUpload(s, local, joinPosix(cwd, name)),
      );
    }
    void navigate(cwd);
  }, [cwd, runTransfer, navigate]);

  const mkdir = useCallback(async () => {
    const s = specRef.current;
    if (!s) return;
    const name = window.prompt(t('sftp.newFolderPrompt'));
    if (!name?.trim()) return;
    try {
      await sftpMkdir(s, joinPosix(cwd, name.trim()));
      void navigate(cwd);
    } catch (e) {
      fail(e);
    }
  }, [cwd, navigate, fail, t]);

  const rename = useCallback(
    async (entry: SftpEntry) => {
      const s = specRef.current;
      if (!s) return;
      const next = window.prompt(t('sftp.renamePrompt'), entry.name);
      if (!next?.trim() || next.trim() === entry.name) return;
      try {
        await sftpRename(s, entry.path, joinPosix(cwd, next.trim()));
        void navigate(cwd);
      } catch (e) {
        fail(e);
      }
    },
    [cwd, navigate, fail, t],
  );

  const remove = useCallback(
    async (entry: SftpEntry) => {
      const s = specRef.current;
      if (!s) return;
      if (!window.confirm(t('sftp.deleteConfirm', { name: entry.name }))) return;
      try {
        await sftpRemove(s, entry.path, entry.type === 'dir');
        void navigate(cwd);
      } catch (e) {
        fail(e);
      }
    },
    [cwd, navigate, fail, t],
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
                <SelectItem key={h.id} value={String(h.id)}>{h.label}</SelectItem>
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
              onClick={() => (e.type === 'dir' ? void navigate(e.path) : void download(e))}
            >
              {e.name}
            </button>
            <span className="text-muted-foreground tabular-nums shrink-0 w-16 text-right">
              {e.type === 'dir' ? '' : fmtBytes(e.size)}
            </span>
            {e.type !== 'dir' && (
              <button type="button" aria-label={t('sftp.download')} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5" onClick={() => void download(e)}>
                <Download className="h-3 w-3" />
              </button>
            )}
            <button type="button" aria-label={t('sftp.rename')} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5" onClick={() => void rename(e)}>
              <Pencil className="h-3 w-3" />
            </button>
            <button type="button" aria-label={t('sftp.delete')} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 hover:text-red-500" onClick={() => void remove(e)}>
              <Trash2 className="h-3 w-3" />
            </button>
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
                {tf.error ? (
                  <span className="text-red-500 shrink-0">{tf.error}</span>
                ) : (
                  <span className="text-muted-foreground tabular-nums shrink-0">{tf.done ? '100%' : `${pct}%`}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
