/**
 * Filesystem adapter — the abstraction that lets ONE `FilePane` component drive
 * both sides of the dual-pane manager. The local side (project files over the
 * `files.*` HTTP/IPC routes) and the remote side (SFTP) implement the same
 * interface; the pane never knows which it's talking to.
 *
 * Path conventions differ per side and each adapter owns its own `join`/
 * `parentDir`: local paths are PROJECT-RELATIVE posix (`''` = root, `src/a`);
 * remote paths are ABSOLUTE posix (`/`, `/home/x`). `toLocalAbs` bridges a
 * pane path to a real on-disk absolute path for `fastGet`/`fastPut` (remote
 * side throws — it has no local path).
 */

export interface FsItem {
  name: string;
  /** Adapter-native path (project-relative posix for local, absolute posix for remote). */
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  /** Modified time, epoch ms (0 when unknown — the local tree fast-path doesn't stat). */
  mtime: number;
}

export interface FsAdapter {
  readonly kind: 'local' | 'remote';
  /** Short human label for the pane header (project folder name / host label). */
  readonly label: string;
  /** Resolve the initial directory to show (project root `''` / remote `$HOME`). */
  homeDir(): Promise<string>;
  /** Parent directory of a pane path (pure). Clamped at the adapter's root. */
  parentDir(path: string): string;
  /** Join a child name onto a directory path (pure). */
  join(dir: string, name: string): string;
  list(dir: string): Promise<FsItem[]>;
  mkdir(dir: string, name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, isDir: boolean): Promise<void>;
  /** Absolute on-disk path for a pane path — feeds fastGet/fastPut. Remote: throws. */
  toLocalAbs(path: string): string;
}

export function fmtBytes(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Last path segment of a posix or native path. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
