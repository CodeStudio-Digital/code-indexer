/**
 * Orchestrates a host scaffold: resolve a free `~/.mcp-code-indexer/projects/<slug>`,
 * run the template's CLI steps (streaming logs), and hand the resolved
 * target back to the caller for DB registration. The runner NEVER touches
 * the database and NEVER deletes a half-written directory on failure
 * (destructive on the host) — it just reports the path and the error.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveTargetPath, type ResolvedTarget } from './paths.js';
import { runHostCommand } from './run-host-command.js';
import { getHostTemplate } from './templates/registry.js';
import { NON_INTERACTIVE_ENV } from './templates/types.js';
import type { ScaffoldInput } from './validate.js';

export interface ScaffoldCallbacks {
  onStart?: (d: { template: string; slug: string; targetPath: string }) => void;
  onPhase?: (d: { phase: string; label: string }) => void;
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface ScaffoldRunInput extends ScaffoldInput {
  /** True when the DB already has a project with this display name. */
  isNameTaken?: (name: string) => boolean;
  /** Override the projects root (tests). */
  root?: string;
  signal?: AbortSignal;
}

export type ScaffoldOutcome =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; target: ResolvedTarget | null; error: { message: string; stderrTail?: string } };

export async function runHostScaffold(
  input: ScaffoldRunInput,
  cb: ScaffoldCallbacks = {},
): Promise<ScaffoldOutcome> {
  const template = getHostTemplate(input.template);

  let target: ResolvedTarget;
  try {
    cb.onPhase?.({ phase: 'resolve-path', label: 'Resolving project location' });
    target = resolveTargetPath(input.name, { root: input.root, isNameTaken: input.isNameTaken });
  } catch (err) {
    return { ok: false, target: null, error: { message: err instanceof Error ? err.message : String(err) } };
  }

  cb.onStart?.({ template: input.template, slug: target.slug, targetPath: target.targetPath });

  if (template.createsTargetDir) {
    mkdirSync(target.targetPath, { recursive: true });
  }

  const steps = template.build({
    slug: target.slug,
    targetDir: target.targetPath,
    repoUrl: input.repoUrl,
    gitInit: input.gitInit,
  });

  for (const step of steps) {
    if (input.signal?.aborted) {
      return { ok: false, target, error: { message: 'Cancelled' } };
    }
    cb.onPhase?.({ phase: step.phase, label: step.label });
    const cwd = step.cwd === 'parent' ? path.dirname(target.targetPath) : target.targetPath;
    const result = await runHostCommand({
      program: step.program,
      args: step.args,
      cwd,
      env: NON_INTERACTIVE_ENV,
      timeoutMs: step.timeoutMs,
      signal: input.signal,
      onLog: cb.onLog,
    });
    if (!result.ok) {
      return {
        ok: false,
        target,
        error: { message: `${step.label} failed (exit ${result.exitCode})`, stderrTail: result.stderrTail },
      };
    }
  }

  // Guard: a CLI can exit 0 yet not produce the directory we expect.
  if (!existsSync(target.targetPath)) {
    return { ok: false, target, error: { message: `Scaffold finished but ${target.targetPath} was not created` } };
  }

  return { ok: true, target };
}
