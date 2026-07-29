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
  /** Unix permission bits (0 when unknown). Remote SFTP always provides; local only with withStats. */
  mode: number;
  /** Owner uid/gid. Remote only — meaningless on Windows, so the local adapter omits them. */
  uid?: number;
  gid?: number;
  /** Resolved account names (`root`, `www-data`), when the host's passwd/group could be read. */
  owner?: string;
  group?: string;
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

/**
 * Unix permission bits → `rwxr-xr-x` with a type prefix from `item.type`
 * (Windows fs.stat fakes the mode bits, so the type comes from the Dirent
 * instead). Returns empty for an unknown (0) mode.
 */
export function fmtMode(mode: number, type: 'file' | 'dir' | 'symlink' | 'other'): string {
  if (!mode) return '';
  const prefix = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : '-';
  const bits = mode & 0o777;
  const triple = (shift: number): string => {
    const r = (bits >> shift) & 4 ? 'r' : '-';
    const w = (bits >> shift) & 2 ? 'w' : '-';
    const x = (bits >> shift) & 1 ? 'x' : '-';
    return `${r}${w}${x}`;
  };
  return `${prefix}${triple(6)}${triple(3)}${triple(0)}`;
}

/**
 * Account name if the host's passwd/group could be read, else the raw numeric
 * id (what every SFTP client falls back to), else empty for the local side.
 */
export function fmtOwner(name: string | undefined, id: number | undefined): string {
  if (name) return name;
  return id == null ? '' : String(id);
}

/** Epoch ms → compact `YYYY-MM-DD HH:mm`. Empty when mtime is 0/unknown. */
export function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Last path segment of a posix or native path. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
