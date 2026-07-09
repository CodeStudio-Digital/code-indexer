/**
 * Local filesystem adapter — the project pane. Backed by the project-scoped
 * `files.*` routes (tree/mkdir/rename/delete), so it can only reach paths under
 * the project's `root_path` (the backend's `resolveSafe` enforces it). Paths are
 * project-relative posix; `toLocalAbs` joins the project root with the native
 * separator for SFTP transfers.
 */

import type { FileTreeNode } from '@mcp/api-bus';
import { apiCall } from '../../../lib/api-client.js';
import { toNativeAbsolute } from '../../../lib/path-ref.js';
import { baseName, type FsAdapter, type FsItem } from './fs-adapter.js';

export function createLocalAdapter(projectId: number, rootPath: string): FsAdapter {
  const parentDir = (p: string): string => {
    if (!p) return '';
    const i = p.lastIndexOf('/');
    return i <= 0 ? '' : p.slice(0, i);
  };
  const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

  return {
    kind: 'local',
    label: baseName(rootPath.replace(/[\\/]+$/, '')) || 'local',
    async homeDir() {
      return '';
    },
    parentDir,
    join,
    async list(dir) {
      // maxDepth 1 → one readdir, immediate children only. withStats populates
      // size/mtime/mode per child for the SFTP pane's columns (one extra stat
      // per entry; the default FileTreeRail path omits it).
      const node = await apiCall<FileTreeNode>('files.tree', { projectId, root: dir || '.', maxDepth: 1, withStats: true } as Record<string, unknown>);
      return (node.children ?? []).map(
        (c): FsItem => ({
          name: c.name,
          path: c.path,
          type: c.type === 'dir' ? 'dir' : 'file',
          size: c.size ?? 0,
          mtime: c.mtime ?? 0,
          mode: c.mode ?? 0,
        }),
      );
    },
    async mkdir(dir, name) {
      await apiCall('files.mkdir', { projectId, path: join(dir, name) });
    },
    async rename(from, to) {
      await apiCall('files.rename', { projectId, from, to });
    },
    async remove(path, isDir) {
      await apiCall('files.delete', { projectId, path, recursive: isDir });
    },
    toLocalAbs(path) {
      return toNativeAbsolute(rootPath, path);
    },
  };
}
