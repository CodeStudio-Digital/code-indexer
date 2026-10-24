import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { runGit } from './git-process.js';

export interface GitFileStatus {
  path: string;
  index: string;   // single-char status from porcelain v2 ('.', 'M', 'A', 'D', '?', …)
  worktree: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export function hasGitDir(root: string): boolean {
  return existsSync(path.join(root, '.git'));
}

/**
 * Parse `git status --porcelain=v2 --branch` output into a structured
 * snapshot. Porcelain v2 is machine-stable and gives us ahead/behind for
 * free via header lines.
 */
export async function gitStatus(root: string): Promise<GitStatus> {
  if (!hasGitDir(root)) {
    return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  }
  const r = await runGit(root, ['status', '--porcelain=v2', '--branch']);
  if (!r.ok) {
    return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  }
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // "1 XY … path" or "2 XY … path<TAB>orig"
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const pathIdx = line.indexOf(parts[8] ?? '');
      const rest = pathIdx >= 0 ? line.slice(pathIdx) : parts.slice(8).join(' ');
      files.push({ path: rest.split('\t')[0], index: xy[0] ?? '.', worktree: xy[1] ?? '.' });
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), index: '?', worktree: '?' });
    } else if (line.startsWith('! ')) {
      files.push({ path: line.slice(2), index: '!', worktree: '!' });
    }
  }
  return { isRepo: true, branch, upstream, ahead, behind, files };
}
