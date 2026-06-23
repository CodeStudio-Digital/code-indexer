/**
 * SFTP manager — a remote file browser + transfers over the host's pooled ssh2
 * connection. One cached SFTP session per host (holds one ref on the pooled
 * connection until `close`). Transfers use ssh2 `fastGet`/`fastPut` (which do
 * the local disk I/O + give a progress `step`), surfaced as an AsyncIterable of
 * `SftpProgress` — consumed by the renderer exactly like `terminal.output`.
 */

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
  return { name: e.filename, path: joinPosix(dir, e.filename), type, size: a.size, mtime: a.mtime * 1000, mode: a.mode };
}

interface SftpSession {
  sftp: SFTPWrapper;
  /** Idempotently return the pooled-connection ref this session holds. */
  release: () => void;
}

export class SftpManager {
  private readonly sessions = new Map<string, SftpSession>();
  /** Max bytes we'll pull into the editor — larger files belong in a download. */
  private static readonly MAX_EDIT_BYTES = 2 * 1024 * 1024;

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
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.manager.release(spec.hostId);
    };
    const session: SftpSession = { sftp, release };
    this.sessions.set(spec.hostId, session);
    const drop = (): void => {
      if (this.sessions.get(spec.hostId) === session) this.sessions.delete(spec.hostId);
      release();
    };
    client.on('close', drop);
    sftp.on('close', drop);
    return sftp;
  }

  close(hostId: string): void {
    const session = this.sessions.get(hostId);
    if (!session) return;
    this.sessions.delete(hostId);
    try {
      session.sftp.end();
    } catch {
      /* already closed */
    }
    session.release(); // idempotent — a no-op if the channel already closed
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

  async remove(spec: SshConnectSpec, path: string, isDir: boolean): Promise<void> {
    const sftp = await this.get(spec);
    await voidOp((cb) => (isDir ? sftp.rmdir(path, cb) : sftp.unlink(path, cb)));
  }

  download(spec: SshConnectSpec, remotePath: string, localPath: string): AsyncIterable<SftpProgress> {
    return transferStream((onProgress, done) => {
      void this.get(spec)
        .then((sftp) => {
          sftp.fastGet(
            remotePath,
            localPath,
            { step: (transferred, _chunk, total) => onProgress(transferred, total) },
            (err) => done(err ?? undefined),
          );
        })
        .catch(done);
    });
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

  upload(spec: SshConnectSpec, localPath: string, remotePath: string): AsyncIterable<SftpProgress> {
    return transferStream((onProgress, done) => {
      void this.get(spec)
        .then((sftp) => {
          sftp.fastPut(
            localPath,
            remotePath,
            { step: (transferred, _chunk, total) => onProgress(transferred, total) },
            (err) => done(err ?? undefined),
          );
        })
        .catch(done);
    });
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
