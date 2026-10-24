/**
 * Drive file tree — converts the flat `DriveFileMeta[]` list (whose paths
 * are slash-delimited, e.g. "Refatoração Angular Home/03 - Relatórios/x.md")
 * into a nested folder/file structure so the Drive panel can group files by
 * folder instead of showing one long flat list.
 *
 * `buildDriveTree` also applies the search filter: with a non-empty query it
 * keeps only files whose full path matches (case-insensitive substring) and
 * prunes empty folders. Folders are listed before files, both alphabetical.
 */
import type { DriveFileMeta } from '../../../state/company/driveSlice.js';

export type DriveTreeNode =
  | { type: 'dir'; name: string; path: string; children: DriveTreeNode[]; fileCount: number }
  | { type: 'file'; name: string; path: string; file: DriveFileMeta };

interface DirAccum {
  name: string;
  path: string;
  dirs: Map<string, DirAccum>;
  files: DriveFileMeta[];
}

function emptyDir(name: string, path: string): DirAccum {
  return { name, path, dirs: new Map(), files: [] };
}

function leaf(path: string): string {
  return path.split('/').pop() || path;
}

/** Build the folder-grouped tree, optionally filtered by `query`. */
export function buildDriveTree(files: DriveFileMeta[], query: string): DriveTreeNode[] {
  const q = query.trim().toLowerCase();
  const matched = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;

  const root = emptyDir('', '');
  for (const f of matched) {
    const segs = f.path.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    let cur = root;
    // All segments but the last are folders; create them lazily.
    for (let i = 0; i < segs.length - 1; i++) {
      const name = segs[i];
      const childPath = cur.path ? `${cur.path}/${name}` : name;
      let next = cur.dirs.get(name);
      if (!next) {
        next = emptyDir(name, childPath);
        cur.dirs.set(name, next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  return toNodes(root);
}

function toNodes(dir: DirAccum): DriveTreeNode[] {
  const dirNodes: DriveTreeNode[] = [];
  for (const child of dir.dirs.values()) {
    const children = toNodes(child);
    dirNodes.push({
      type: 'dir',
      name: child.name,
      path: child.path,
      children,
      fileCount: countFiles(children),
    });
  }
  dirNodes.sort((a, b) => a.name.localeCompare(b.name));

  const fileNodes: DriveTreeNode[] = dir.files
    .map((f): DriveTreeNode => ({ type: 'file', name: leaf(f.path), path: f.path, file: f }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...dirNodes, ...fileNodes];
}

function countFiles(nodes: DriveTreeNode[]): number {
  let n = 0;
  for (const node of nodes) n += node.type === 'file' ? 1 : node.fileCount;
  return n;
}

/**
 * Drive namespace maintained by the agents' `docs_write` tool (see
 * `packages/company/src/tools/file-path-core.ts`). These rows are a
 * read-only MIRROR of the sandbox docs tree — the Drive panel renders
 * them in a separate collapsed section instead of the main tree.
 */
const DOCS_MIRROR_PREFIX = '__docs__/';

export interface DriveMirrorFile {
  /** Path with the `__docs__/` prefix stripped (e.g. "main/adr/0001.md"). */
  displayPath: string;
  file: DriveFileMeta;
}

/** Split the drive listing into work artifacts vs the docs mirror. */
export function partitionDriveFiles(files: DriveFileMeta[]): {
  work: DriveFileMeta[];
  docsMirror: DriveMirrorFile[];
} {
  const work: DriveFileMeta[] = [];
  const docsMirror: DriveMirrorFile[] = [];
  for (const f of files) {
    if (f.path.startsWith(DOCS_MIRROR_PREFIX)) {
      docsMirror.push({ displayPath: f.path.slice(DOCS_MIRROR_PREFIX.length), file: f });
    } else {
      work.push(f);
    }
  }
  docsMirror.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  return { work, docsMirror };
}

/** Every file path under a list of nodes (recursive). Used by folder delete. */
export function collectFilePaths(nodes: DriveTreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path);
    else out.push(...collectFilePaths(n.children));
  }
  return out;
}

/** Human-readable byte size. Shared by the tree rows. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
