/**
 * Conflict-resolution engine for the project-local git surface — split
 * out of `projectGit/index.ts` to keep that god-file from growing. It is
 * a factory injected with the same spawn helpers + repo resolver so there
 * is one source of truth for shelling out to git.
 *
 * Covers the full mid-sequence lifecycle git leaves behind on a conflict:
 * detect which op is in flight (merge / cherry-pick / revert / rebase),
 * read a conflicted file's three index stages, resolve a file (take a
 * side or write merged text), then continue or abort the op.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  ApiError,
  type ProjectGitApi,
  type MergeKind,
  type GitRunResult,
} from '@mcp/api-bus';
import { detectMergeKind, listConflictedFiles } from './sequencer.js';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The slice of index.ts internals the engine needs — injected, not re-implemented. */
export interface ConflictDeps {
  runGit(
    cwd: string,
    args: string[],
    optsOrStdin?: string | { stdin?: string; env?: Record<string, string> },
  ): Promise<GitResult>;
  runAsResult(
    cwd: string,
    cmd: 'git',
    args: string[],
    env?: Record<string, string>,
  ): Promise<GitRunResult>;
  requireRoot(projectId: number): string;
  detectRepo(root: string): Promise<{ repoRoot: string | null; notARepo: boolean }>;
}

type ConflictApi = Pick<
  ProjectGitApi,
  'mergeState' | 'conflictFile' | 'resolveConflict' | 'mergeContinue' | 'mergeAbort'
>;

/**
 * Resolve a repoRoot-relative path to an absolute one, refusing escapes.
 * Rooted at REPOROOT (not the project root_path) because git emits
 * conflicted paths relative to the repo root, which can be an ancestor of
 * the project directory.
 */
function safeJoin(repoRoot: string, rel: string): string {
  const normRoot = path.resolve(repoRoot);
  const candidate = path.resolve(normRoot, rel);
  const inside = path.relative(normRoot, candidate);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new ApiError('path_escape', 403, 'path escapes repo root');
  }
  return candidate;
}

// A NUL byte decodes to U+0000 in the strings git hands back, so its
// presence is a cheap "this blob isn't text" signal. (String.fromCharCode
// keeps the source free of an embedded control character.)
const NUL = String.fromCharCode(0);
const looksBinary = (s: string | null): boolean => typeof s === 'string' && s.includes(NUL);

export function createConflictHandlers(deps: ConflictDeps): ConflictApi {
  async function resolveRepoRoot(projectId: number) {
    const root = deps.requireRoot(projectId);
    return deps.detectRepo(root);
  }

  return {
    async mergeState({ projectId }) {
      const empty = { kind: null as MergeKind | null, conflictedFiles: [], oursLabel: '', theirsLabel: '' };
      const { repoRoot, notARepo } = await resolveRepoRoot(projectId);
      if (notARepo || !repoRoot) return empty;
      const { kind, incomingSha } = await detectMergeKind(deps.runGit, repoRoot);
      if (!kind) return empty;
      const conflictedFiles = await listConflictedFiles(deps.runGit, repoRoot);
      const branch = (await deps.runGit(repoRoot, ['branch', '--show-current'])).stdout.trim();
      let incomingSubject: string | undefined;
      if (incomingSha) {
        const s = await deps.runGit(repoRoot, ['show', '-s', '--format=%s', incomingSha]);
        if (s.code === 0) incomingSubject = s.stdout.trim();
      }
      const shortSha = incomingSha ? incomingSha.slice(0, 7) : '';
      return {
        kind,
        conflictedFiles,
        oursLabel: branch || 'HEAD (detached)',
        theirsLabel: incomingSubject || shortSha || kind,
        incomingSubject,
        incomingSha,
      };
    },

    async conflictFile({ projectId, path: rel }) {
      const { repoRoot, notARepo } = await resolveRepoRoot(projectId);
      if (notARepo || !repoRoot) throw new ApiError('not_a_repo', 400, 'not a git repository');
      const showStage = async (n: 1 | 2 | 3): Promise<string | null> => {
        const r = await deps.runGit(repoRoot, ['show', `:${n}:${rel}`]);
        return r.code === 0 ? r.stdout : null;
      };
      const [base, ours, theirs] = await Promise.all([showStage(1), showStage(2), showStage(3)]);
      let merged = '';
      try {
        merged = await fs.readFile(safeJoin(repoRoot, rel), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const binary = [base, ours, theirs, merged].some(looksBinary);
      return {
        base,
        ours,
        theirs,
        merged: binary ? '' : merged,
        hasOurs: ours !== null,
        hasTheirs: theirs !== null,
        binary,
      };
    },

    async resolveConflict({ projectId, path: rel, resolution }) {
      const { repoRoot, notARepo } = await resolveRepoRoot(projectId);
      if (notARepo || !repoRoot) throw new ApiError('not_a_repo', 400, 'not a git repository');

      if (resolution === 'ours' || resolution === 'theirs') {
        const flag = resolution === 'ours' ? '--ours' : '--theirs';
        const co = await deps.runGit(repoRoot, ['checkout', flag, '--', rel]);
        if (co.code !== 0) {
          // The chosen side deleted the file (modify/delete) — accepting it
          // means staging the deletion, which `git rm` does.
          const rm = await deps.runGit(repoRoot, ['rm', '--', rel]);
          if (rm.code !== 0) {
            throw new ApiError('git_resolve_failed', 500, (co.stderr || rm.stderr).trim() || 'checkout failed');
          }
          return { ok: true as const };
        }
        const add = await deps.runGit(repoRoot, ['add', '--', rel]);
        if (add.code !== 0) throw new ApiError('git_resolve_failed', 500, add.stderr.trim() || 'git add failed');
        return { ok: true as const };
      }

      if (looksBinary(resolution.content)) {
        throw new ApiError('binary_conflict', 400, 'cannot write text content to a binary file');
      }
      const abs = safeJoin(repoRoot, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, resolution.content, 'utf8');
      const add = await deps.runGit(repoRoot, ['add', '--', rel]);
      if (add.code !== 0) throw new ApiError('git_resolve_failed', 500, add.stderr.trim() || 'git add failed');
      return { ok: true as const };
    },

    async mergeContinue({ projectId }) {
      const { repoRoot, notARepo } = await resolveRepoRoot(projectId);
      if (notARepo || !repoRoot) throw new ApiError('not_a_repo', 400, 'not a git repository');
      const { kind } = await detectMergeKind(deps.runGit, repoRoot);
      if (!kind) throw new ApiError('no_merge_in_progress', 409, 'no merge/cherry-pick/revert/rebase in progress');
      const remaining = await listConflictedFiles(deps.runGit, repoRoot);
      if (remaining.length > 0) {
        throw new ApiError('unresolved_conflicts', 409, `${remaining.length} unresolved conflict(s) remain`);
      }
      // GIT_EDITOR=true (and the -c belt-and-suspenders) keep --continue from
      // opening the commit-message editor and hanging the spawned process.
      return deps.runAsResult(repoRoot, 'git', ['-c', 'core.editor=true', kind, '--continue'], {
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
      });
    },

    async mergeAbort({ projectId }) {
      const { repoRoot, notARepo } = await resolveRepoRoot(projectId);
      if (notARepo || !repoRoot) throw new ApiError('not_a_repo', 400, 'not a git repository');
      const { kind } = await detectMergeKind(deps.runGit, repoRoot);
      if (!kind) throw new ApiError('no_merge_in_progress', 409, 'no merge/cherry-pick/revert/rebase in progress');
      return deps.runAsResult(repoRoot, 'git', [kind, '--abort']);
    },
  };
}
