/**
 * Runs one linter over the unsaved buffer and returns a `SarifRun` (or null).
 *
 * WebStorm stylelint's 3-phase model: the caller collects the buffer, this runs
 * the tool OFF the main flow (child process) with the buffer on **stdin**
 * (`--stdin-filename`), and a newer edit cancels the in-flight run via
 * `AbortSignal` (latest-wins). The tool runs in the project's resolved runtime
 * (managed Node on PATH); WSL targeting arrives in phase 2.
 *
 * Linters exit non-zero WHEN THEY FIND PROBLEMS — that is not a failure, so we
 * parse stdout regardless of exit code; only an abort/kill or unparseable
 * output yields null (which leaves existing diagnostics untouched).
 */
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { resolveProjectRuntimeEnv } from '../runtime/runtime-resolve.js';
import type { SarifRun } from './sarif.js';
import { resolveNodeToolBin, type LintToolSpec } from './tool-registry.js';

/** Per-run wall-clock ceiling; a slow/hung tool never blocks re-lint. */
const LINT_TIMEOUT_MS = (() => {
  const v = Number(process.env.MCP_LINT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
})();
/** A single file's JSON report is small, but minified CSS can be noisy — be generous. */
const MAX_OUTPUT_BYTES = 4_000_000;

export interface RunLintOptions {
  db: CodeIndexDB;
  projectId: number;
  root: string;
  managedDir: string;
  spec: LintToolSpec;
  relFile: string;
  content: string;
  signal: AbortSignal;
}

export async function runLintTool(opts: RunLintOptions): Promise<SarifRun | null> {
  const binJs = resolveNodeToolBin(opts.root, opts.spec);
  if (!binJs) return null; // not installed — skip silently

  // Project runtime on PATH (managed Node first) for a `node <binJs>` spawn.
  const runtime = resolveProjectRuntimeEnv(opts.db, opts.projectId, opts.managedDir, { includeNode: true });
  const args = [binJs, ...opts.spec.args(opts.relFile)];

  let res;
  try {
    res = await defaultLocalShellPort().spawn('node', args, {
      cwd: opts.root,
      timeoutMs: LINT_TIMEOUT_MS,
      signal: opts.signal,
      stdin: opts.content,
      runtimeEnv: { pathPrepend: runtime.pathPrepend, extraEnv: runtime.extraEnv },
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  } catch {
    return null;
  }

  // Superseded by a newer edit, killed, or crashed before producing JSON.
  if (opts.signal.aborted || res.timedOut || res.exitCode === null) return null;
  const out = res.stdout.trim();
  // Empty stdout with a non-zero exit means a tool/config error (e.g. no eslint
  // config) — NOT "file is clean"; leave existing diagnostics alone.
  if (!out) return res.exitCode === 0 ? { tool: opts.spec.id, results: [] } : null;
  try {
    return opts.spec.parse(out);
  } catch {
    return null; // partial/garbled JSON — don't clobber
  }
}
