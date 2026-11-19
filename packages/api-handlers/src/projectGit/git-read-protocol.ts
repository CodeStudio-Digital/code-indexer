import type { GitProcessInput, GitResult } from './git-process.js';

export type GitReadRequest =
  | { type: 'run'; id: number; input: GitProcessInput; pid: SharedArrayBuffer }
  | { type: 'cancel'; id: number }
  | { type: 'dispose' };
export type GitReadResponse =
  | { type: 'spawned'; id: number; pid: number }
  | { type: 'result'; id: number; result: GitResult };

/** Classification is conservative: mutations and network commands never move. */
export function isReadOnlyGit(args: readonly string[], profile?: 'read' | 'mutation' | 'network'): boolean {
  if (profile === 'mutation' || profile === 'network') return false;
  if (args.some(arg => arg === '--output' || arg.startsWith('--output='))) return false;
  const [command, ...rest] = args;
  if (command === 'worktree') return rest[0] === 'list';
  if (['status', 'rev-parse', 'check-ignore', 'check-ref-format', 'show-ref', 'rev-list',
    'for-each-ref', 'ls-files', 'ls-tree', 'cat-file', 'merge-base', 'log', 'show', 'diff'].includes(command ?? '')) {
    return !rest.some(arg => arg === '--output' || arg.startsWith('--output='));
  }
  if (command === 'config') return rest.some(arg => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(arg))
    && !rest.some(arg => ['--unset', '--unset-all', '--add', '--replace-all', '--remove-section', '--rename-section', '--edit', '-e'].includes(arg));
  if (command === 'remote') return rest.length === 0 || rest[0] === 'get-url';
  if (command === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (command === 'symbolic-ref') return rest.filter(arg => !arg.startsWith('-')).length === 1
    && !rest.some(arg => arg === '-d' || arg.startsWith('--delete'));
  return false;
}
