/**
 * SFTP manager — a remote file browser + transfers over the host's pooled ssh2
 * connection. One cached SFTP session per host (holds one ref on the pooled
 * connection until `close`). Transfers use ssh2 `fastGet`/`fastPut` (which do
 * the local disk I/O + give a progress `step`), surfaced as an AsyncIterable of
 * `SftpProgress` — consumed by the renderer exactly like `terminal.output`.
 */

import type { Client, SFTPWrapper, FileEntryWithStats } from 'ssh2';
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

export class SftpManager {
  private readonly sessions = new Map<string, SFTPWrapper>();

  constructor(private readonly manager: SshConnectionManager) {}

  private async get(spec: SshConnectSpec): Promise<SFTPWrapper> {
    const existing = this.sessions.get(spec.hostId);
    if (existing) return existing;
    const client = await this.manager.acquire(spec); // throws host-key/connect errors
    let sftp: SFTPWrapper;
    try {
      sftp = await openSftp(client);
    } catch (err) {
      this.manager.release(spec.hostId);
      throw err;
    }
    this.sessions.set(spec.hostId, sftp);
    const drop = (): void => {
      this.sessions.delete(spec.hostId);
    };
    client.on('close', drop);
    sftp.on('close', drop);
    return sftp;
  }

  close(hostId: string): void {
    const sftp = this.sessions.get(hostId);
    if (!sftp) return;
    this.sessions.delete(hostId);
    try {
      sftp.end();
    } catch {
      /* already closed */
    }
    this.manager.release(hostId);
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
