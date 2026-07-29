/**
 * SFTP manager — a remote file browser + transfers over the host's pooled ssh2
 * connection. One cached SFTP session per host (holds one ref on the pooled
 * connection until `close`). Transfers use ssh2 `fastGet`/`fastPut` (which do
 * the local disk I/O + give a progress `step`), surfaced as an AsyncIterable of
 * `SftpProgress` — consumed by the renderer exactly like `terminal.output`.
 */

import { rm } from 'node:fs/promises';
import type { Client, SFTPWrapper, FileEntryWithStats, Stats } from 'ssh2';
import { ApiError, type SftpEntry, type SftpProgress, type SshConnectSpec } from '@mcp/api-bus';
import type { SshConnectionManager } from './ssh-connection-manager.js';

function joinPosix(dir: string, name: string): string {
  if (dir === '/' || dir.endsWith('/')) return `${dir}${name}`;
  return `${dir}/${name}`;
}

function toEntry(dir: string, e: FileEntryWithStats): SftpEntry {
  const a = e.attrs;
  const type = a.isDirectory() ? 'dir' : a.isSymbolicLink() ? 'symlink' : a.isFile() ? 'file' : 'other';
  return {
    name: e.filename,
    path: joinPosix(dir, e.filename),
    type,
    size: a.size,
    mtime: a.mtime * 1000,
    mode: a.mode,
    // Numeric only — the protocol carries no names. See sftpIdNames.
    uid: a.uid,
    gid: a.gid,
  };
}

interface SftpSession {
  sftp: SFTPWrapper;
  /** Idempotently close listeners/channel and return the pooled ref. */
  close: (endChannel: boolean) => void;
}

export class SftpManager {
  private readonly sessions = new Map<string, SftpSession>();
  /** Active cancellable transfers: transferId → abort fn (ends its dedicated channel). */
  private readonly transfers = new Map<string, () => void>();
  /** Max bytes we'll pull into the editor — larger files belong in a download. */
  private static readonly MAX_EDIT_BYTES = 2 * 1024 * 1024;
  /** Recursive-delete guards: a runaway walk on a server is not recoverable. */
  private static readonly MAX_DELETE_DEPTH = 40;
  private static readonly MAX_DELETE_ENTRIES = 50_000;

  constructor(private readonly manager: SshConnectionManager) {}

  private async get(spec: SshConnectSpec): Promise<SFTPWrapper> {
    const existing = this.sessions.get(spec.hostId);
    if (existing) return existing.sftp;
    const client = await this.manager.acquire(spec); // throws host-key/connect errors
    let sftp: SFTPWrapper;
    try {
      sftp = await openSftp(client);
    } catch (err) {
      this.manager.release(spec.hostId);
      throw err;
    }
    // Return the acquired ref EXACTLY once — whether the whole connection dies,
    // the SFTP channel alone closes (SFTP is one channel on a multiplexed
    // Client that a shell/tunnel may keep alive), or close() is called. Without
    // this, an independent SFTP-channel close would strand the ref and the
    // pooled connection could never reach refCount 0 (leak).
    let closed = false;
    const onClientClose = (): void => close(false);
    const onSftpClose = (): void => close(false);
    const close = (endChannel: boolean): void => {
      if (closed) return;
      closed = true;
      if (this.sessions.get(spec.hostId) === session) this.sessions.delete(spec.hostId);
      client.removeListener('close', onClientClose);
      sftp.removeListener('close', onSftpClose);
      if (endChannel) {
        try { sftp.end(); } catch { /* already closed */ }
      }
      this.manager.release(spec.hostId);
    };
    const session: SftpSession = { sftp, close };
    this.sessions.set(spec.hostId, session);
    client.once('close', onClientClose);
    sftp.once('close', onSftpClose);
    return sftp;
  }

  close(hostId: string): void {
    const session = this.sessions.get(hostId);
    if (!session) return;
    session.close(true);
  }

  closeAll(): void {
    for (const transferId of [...this.transfers.keys()]) this.cancel(transferId);
    for (const session of [...this.sessions.values()]) session.close(true);
  }

  async realpath(spec: SshConnectSpec, path: string): Promise<string> {
    const sftp = await this.get(spec);
    return new Promise<string>((resolve, reject) => {
      sftp.realpath(path, (err, abs) => (err ? reject(sftpError(err)) : resolve(abs)));
    });
  }

  async list(spec: SshConnectSpec, path: string): Promise<SftpEntry[]> {
    const sftp = await this.get(spec);
    const abs = await new Promise<string>((resolve, reject) => {
      sftp.realpath(path, (err, p) => (err ? reject(sftpError(err)) : resolve(p)));
    });
    const list = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(abs, (err, l) => (err ? reject(sftpError(err)) : resolve(l)));
    });
    return list
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => toEntry(abs, e))
      .sort((a, b) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name));
  }

  async mkdir(spec: SshConnectSpec, path: string): Promise<void> {
    const sftp = await this.get(spec);
    await voidOp((cb) => sftp.mkdir(path, cb));
  }

  async rename(spec: SshConnectSpec, from: string, to: string): Promise<void> {
    const sftp = await this.get(spec);
    await voidOp((cb) => sftp.rename(from, to, cb));
  }

  /** Change permission bits. `mode` is the low 12 bits (e.g. 0o755). */
  async chmod(spec: SshConnectSpec, path: string, mode: number, recursive = false): Promise<void> {
    const sftp = await this.get(spec);
    if (!recursive) {
      await voidOp((cb) => sftp.chmod(path, mode, cb));
      return;
    }
    await this.walkApply(sftp, path, 0, { count: 0 }, (p) => voidOp((cb) => sftp.chmod(p, mode, cb)));
  }

  /**
   * Change owner/group. Almost always requires root on the remote side, so a
   * permission failure here is expected and surfaced verbatim rather than
   * dressed up — the user needs to know it's the server refusing, not us.
   */
  async chown(spec: SshConnectSpec, path: string, uid: number, gid: number, recursive = false): Promise<void> {
    const sftp = await this.get(spec);
    if (!recursive) {
      await voidOp((cb) => sftp.chown(path, uid, gid, cb));
      return;
    }
    await this.walkApply(sftp, path, 0, { count: 0 }, (p) => voidOp((cb) => sftp.chown(p, uid, gid, cb)));
  }

  /** Apply `fn` to `path` and, if it is a directory, everything beneath it. */
  private async walkApply(
    sftp: SFTPWrapper,
    path: string,
    depth: number,
    budget: { count: number },
    fn: (p: string) => Promise<void>,
  ): Promise<void> {
    if (depth > SftpManager.MAX_DELETE_DEPTH) {
      throw new ApiError('sftp_walk_too_deep', 400, `refusing to recurse deeper than ${SftpManager.MAX_DELETE_DEPTH} levels`);
    }
    await fn(path);
    const st = await new Promise<Stats | null>((resolve) => {
      sftp.lstat(path, (err, s) => resolve(err ? null : s));
    });
    // Symlinks are not descended: chmod -R through a link would alter files
    // outside the selected tree.
    if (!st?.isDirectory() || st.isSymbolicLink()) return;
    const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(path, (err, l) => (err ? reject(sftpError(err)) : resolve(l)));
    });
    for (const e of entries) {
      if (e.filename === '.' || e.filename === '..') continue;
      if (++budget.count > SftpManager.MAX_DELETE_ENTRIES) {
        throw new ApiError('sftp_walk_too_many', 400, `refusing to touch more than ${SftpManager.MAX_DELETE_ENTRIES} entries at once`);
      }
      await this.walkApply(sftp, joinPosix(path, e.filename), depth + 1, budget, fn);
    }
  }

  /**
   * Delete a file, or a directory AND EVERYTHING UNDER IT.
   *
   * SFTP has no recursive remove: `rmdir` fails with "failure" on any directory
   * that still has entries. The old one-shot `rmdir` therefore only ever worked
   * on empty folders — deleting a real directory just errored.
   *
   * So we walk it ourselves, depth-first, unlinking files on the way down and
   * removing directories on the way back up. Deliberately NOT `rm -rf` over
   * exec: that needs a shell, and one bad path expansion there is unrecoverable
   * on someone's server.
   */
  async remove(spec: SshConnectSpec, path: string, isDir: boolean): Promise<void> {
    const sftp = await this.get(spec);
    if (!isDir) {
      await voidOp((cb) => sftp.unlink(path, cb));
      return;
    }
    await this.removeDirRecursive(sftp, path, 0, { count: 0 });
  }

  private async removeDirRecursive(
    sftp: SFTPWrapper,
    dir: string,
    depth: number,
    budget: { count: number },
  ): Promise<void> {
    if (depth > SftpManager.MAX_DELETE_DEPTH) {
      throw new ApiError('sftp_delete_too_deep', 400, `refusing to delete deeper than ${SftpManager.MAX_DELETE_DEPTH} levels`);
    }
    const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(dir, (err, l) => (err ? reject(sftpError(err)) : resolve(l)));
    });
    for (const e of entries) {
      if (e.filename === '.' || e.filename === '..') continue;
      if (++budget.count > SftpManager.MAX_DELETE_ENTRIES) {
        throw new ApiError('sftp_delete_too_many', 400, `refusing to delete more than ${SftpManager.MAX_DELETE_ENTRIES} entries at once`);
      }
      const child = joinPosix(dir, e.filename);
      // A symlink is unlinked, never followed — following one would delete
      // whatever it points at, outside the tree the user selected.
      if (e.attrs.isDirectory() && !e.attrs.isSymbolicLink()) {
        await this.removeDirRecursive(sftp, child, depth + 1, budget);
      } else {
        await voidOp((cb) => sftp.unlink(child, cb));
      }
    }
    await voidOp((cb) => sftp.rmdir(dir, cb));
  }

  /**
   * Run a fastGet/fastPut on a DEDICATED sftp channel (its own ref on the pooled
   * connection), so cancelling it ends ONLY that channel — the browse session and
   * sibling transfers are untouched. The abort fn is registered under `transferId`
   * for `cancel()`; ref release + channel close are idempotent (one settle).
   */
  private transfer(
    transferId: string,
    spec: SshConnectSpec,
    run: (sftp: SFTPWrapper, onProgress: (t: number, total: number) => void, finish: (err?: Error) => void) => void,
    onCancel?: () => void,
  ): AsyncIterable<SftpProgress> {
    return transferStream((onProgress, done) => {
      let channel: SFTPWrapper | null = null;
      let settled = false;
      let acquired = false;
      let released = false;
      const onChannelClose = (): void =>
        settle(new ApiError('sftp_closed', 502, 'SFTP channel closed during transfer'));
      const onChannelError = (error: Error): void => settle(error);
      const release = (): void => {
        if (released) return;
        released = true;
        this.manager.release(spec.hostId);
      };
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        this.transfers.delete(transferId);
        channel?.removeListener('close', onChannelClose);
        channel?.removeListener('error', onChannelError);
        try {
          channel?.end();
        } catch {
          /* already closed */
        }
        if (acquired) release();
        done(err);
      };
      this.transfers.set(transferId, () => {
        onCancel?.();
        settle(new ApiError('sftp_cancelled', 499, 'transfer cancelled'));
      });
      void this.manager
        .acquire(spec)
        .then((client) => {
          acquired = true;
          return openSftp(client);
        })
        .then((sftp) => {
          if (settled) {
            // Cancelled before the channel opened — close it + return the ref.
            try {
              sftp.end();
            } catch {
              /* */
            }
            release();
            return;
          }
          channel = sftp;
          sftp.once('close', onChannelClose);
          sftp.once('error', onChannelError);
          run(sftp, onProgress, (err) => settle(err ?? undefined));
        })
        .catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
    });
  }

  /** Abort an in-flight transfer by id (no-op if it already finished). */
  cancel(transferId: string): void {
    this.transfers.get(transferId)?.();
  }

  download(spec: SshConnectSpec, remotePath: string, localPath: string, transferId: string): AsyncIterable<SftpProgress> {
    return this.transfer(
      transferId,
      spec,
      (sftp, onProgress, finish) =>
        sftp.fastGet(remotePath, localPath, { step: (t, _c, total) => onProgress(t, total) }, (err) => finish(err ?? undefined)),
      // Delete the partial file left behind by a cancelled download.
      () => void rm(localPath, { force: true }).catch(() => undefined),
    );
  }

  /** Read a small remote text file into memory (the in-editor "edit" path). */
  async readFile(spec: SshConnectSpec, remotePath: string): Promise<{ content: string; size: number }> {
    const sftp = await this.get(spec);
    // stat first so the size cap rejects a huge file WITHOUT buffering it.
    const stats = await new Promise<Stats>((resolve, reject) => {
      sftp.stat(remotePath, (err, st) => (err ? reject(sftpError(err)) : resolve(st)));
    });
    if (stats.isDirectory()) throw new ApiError('sftp_is_directory', 400, 'path is a directory');
    if (stats.size > SftpManager.MAX_EDIT_BYTES) {
      throw new ApiError('sftp_file_too_large', 413, `file is ${stats.size} bytes (edit limit ${SftpManager.MAX_EDIT_BYTES})`);
    }
    const buf = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(remotePath, (err, data) => (err ? reject(sftpError(err)) : resolve(data)));
    });
    if (looksBinary(buf)) throw new ApiError('sftp_binary_file', 415, 'file appears to be binary — download it instead');
    let content: string;
    try {
      // fatal → reject non-UTF-8 (latin1/Windows-1252) rather than lossily
      // substituting U+FFFD and re-encoding it back as UTF-8 on save (which
      // would permanently destroy the original bytes). ignoreBOM keeps a leading
      // BOM in the text so it round-trips on write.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      throw new ApiError('sftp_not_utf8', 415, 'file is not valid UTF-8 — download it instead');
    }
    return { content, size: buf.length };
  }

  /** Overwrite a remote file with UTF-8 text (the in-editor save). */
  async writeFile(spec: SshConnectSpec, remotePath: string, content: string): Promise<{ size: number }> {
    const sftp = await this.get(spec);
    const buf = Buffer.from(content, 'utf8');
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, buf, (err) => (err ? reject(sftpError(err)) : resolve()));
    });
    return { size: buf.length };
  }

  upload(spec: SshConnectSpec, localPath: string, remotePath: string, transferId: string): AsyncIterable<SftpProgress> {
    return this.transfer(transferId, spec, (sftp, onProgress, finish) =>
      sftp.fastPut(localPath, remotePath, { step: (t, _c, total) => onProgress(t, total) }, (err) => finish(err ?? undefined)),
    );
  }
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(sftpError(err)) : resolve(sftp)));
  });
}

function voidOp(run: (cb: (err?: Error | null) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    run((err) => (err ? reject(sftpError(err)) : resolve()));
  });
}

function sftpError(err: Error): ApiError {
  return new ApiError('sftp_failed', 502, err.message);
}

/** Heuristic: a NUL byte in the first 8 KB ⇒ treat as binary (not editable text). */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Bridge a callback-style transfer (with a sync progress step) to an AsyncIterable. */
function transferStream(
  run: (onProgress: (transferred: number, total: number) => void, done: (err?: Error) => void) => void,
): AsyncIterable<SftpProgress> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SftpProgress> {
      const queue: SftpProgress[] = [];
      const waiters: Array<(r: IteratorResult<SftpProgress>) => void> = [];
      let ended = false;

      const push = (p: SftpProgress): void => {
        if (waiters.length > 0) waiters.shift()!({ value: p, done: false });
        else queue.push(p);
        if (p.type === 'done' || p.type === 'error') {
          ended = true;
          while (waiters.length > 0) waiters.shift()!({ value: undefined as never, done: true });
        }
      };

      run(
        (transferred, total) => push({ type: 'progress', transferred, total }),
        (err) => push(err ? { type: 'error', message: err.message } : { type: 'done' }),
      );

      return {
        async next(): Promise<IteratorResult<SftpProgress>> {
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          if (ended) return { value: undefined as never, done: true };
          return new Promise<IteratorResult<SftpProgress>>((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}
