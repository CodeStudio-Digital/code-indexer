/**
 * Remote filesystem adapter — the SFTP pane. Thin wrapper over the existing
 * `sftp*` client fns bound to a resolved `SshConnectSpec`. Paths are absolute
 * posix (as the server reports them). `toLocalAbs` is unsupported — remote
 * files have no local path; transfers use the remote path directly.
 */

import type { SshConnectSpec } from '@mcp/api-bus';
import { sftpList, sftpMkdir, sftpRealpath, sftpRemove, sftpRename } from '../api.js';
import type { FsAdapter, FsItem } from './fs-adapter.js';

export function createRemoteAdapter(spec: SshConnectSpec, label: string): FsAdapter {
  const parentDir = (p: string): string => {
    if (p === '/' || !p.includes('/')) return '/';
    const cut = p.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
    return cut || '/';
  };
  const join = (dir: string, name: string): string => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

  return {
    kind: 'remote',
    label,
    homeDir() {
      return sftpRealpath(spec, '.');
    },
    parentDir,
    join,
    // SftpEntry ⊇ FsItem (adds `mode`) — assignable as-is.
    list(dir) {
      return sftpList(spec, dir) as Promise<FsItem[]>;
    },
    async mkdir(dir, name) {
      await sftpMkdir(spec, join(dir, name));
    },
    async rename(from, to) {
      await sftpRename(spec, from, to);
    },
    async remove(path, isDir) {
      await sftpRemove(spec, path, isDir);
    },
    toLocalAbs() {
      throw new Error('remote adapter has no local path');
    },
  };
}
