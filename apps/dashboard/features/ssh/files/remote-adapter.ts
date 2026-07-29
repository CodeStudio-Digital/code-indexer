/**
 * Remote filesystem adapter — the SFTP pane. Thin wrapper over the existing
 * `sftp*` client fns bound to a resolved `SshConnectSpec`. Paths are absolute
 * posix (as the server reports them). `toLocalAbs` is unsupported — remote
 * files have no local path; transfers use the remote path directly.
 */

import type { SftpIdNames, SshConnectSpec } from '@mcp/api-bus';
import { sftpIdNames, sftpList, sftpMkdir, sftpRealpath, sftpRemove, sftpRename } from '../api.js';
import type { FsAdapter, FsItem } from './fs-adapter.js';

const NO_NAMES: SftpIdNames = { users: {}, groups: {} };

export function createRemoteAdapter(spec: SshConnectSpec, label: string): FsAdapter {
  // Resolved once per adapter (main caches per host). Failure is non-fatal —
  // the pane just shows numeric ids, exactly like any other SFTP client.
  let names: Promise<SftpIdNames> | null = null;
  const idNames = (): Promise<SftpIdNames> => (names ??= sftpIdNames(spec).catch(() => NO_NAMES));
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
    // SFTP carries only NUMERIC uid/gid, so the account names are joined in
    // here from the host's passwd/group databases.
    async list(dir) {
      const [entries, resolved] = await Promise.all([sftpList(spec, dir), idNames()]);
      return entries.map((e): FsItem => ({
        ...e,
        owner: resolved.users[String(e.uid)],
        group: resolved.groups[String(e.gid)],
      }));
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
