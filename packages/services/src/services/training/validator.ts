/**
 * Validator — the RLVR gate. Drops a teacher-generated `output` into the
 * profile's sandbox (a real shadcn+Vite project under the data dir for
 * `react-shadcn-vite`, an OS temp dir otherwise), declares `any` for any
 * unresolved imports, runs the profile's validator commands, and only accepts
 * examples that survive the required checks.
 *
 * Commands run via `IShellPort.exec` so each profile expresses its toolchain
 * as plain shell (tsc/eslint/vite build, ruff/mypy/pytest, go vet/test).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type { StackProfile } from './stack-profiles.js';
import type { ValidationResult } from './types.js';
import { ensureSandbox, type StatusFn } from './sandbox.js';
import { writeMissingModuleStubs } from './validator-stubs.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_LOG_CHARS = 4_000;

export interface ValidatorDeps {
  shell: IShellPort;
  /** App data dir — sandboxes live in `{dataDir}/training/sandbox/<profile>`. */
  dataDir: string;
  timeoutMs?: number;
  /** Optional render+screenshot judge; runs only if all command checks pass. */
  visualGate?: (sandboxDir: string) => Promise<ValidationResult>;
  /** Surfaced during one-time sandbox provisioning (npm install can take min). */
  onStatus?: StatusFn;
}

async function resolveSandbox(profile: StackProfile, deps: ValidatorDeps): Promise<string> {
  if (profile.sandbox) return ensureSandbox(deps.dataDir, profile, deps.shell, deps.onStatus);
  return mkdtemp(join(tmpdir(), 'mcp-train-'));
}

export async function validateOutput(
  profile: StackProfile,
  output: string,
  deps: ValidatorDeps,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sandbox = await resolveSandbox(profile, deps);
  const rel = profile.outputPath ?? '__candidate__.txt';
  const target = join(sandbox, rel);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, output, 'utf-8');
  // Declare `any` for imports that don't resolve here (hallucinated component /
  // uninstalled lib) so one bad import doesn't sink an otherwise-valid file.
  const stubPath = await writeMissingModuleStubs(sandbox, output);

  try {
    let log = '';
    for (const c of profile.validatorCmds) {
      const r = await deps.shell.exec(c.cmd, { cwd: sandbox, timeoutMs, signal });
      log += `\n$ ${c.cmd}\n${r.stdout}${r.stderr}`;
      const failed = r.timedOut || (r.exitCode ?? 1) !== 0;
      if (failed && c.required !== false) {
        return { verdict: 'fail', log: clip(`[${c.label}] failed${log}`) };
      }
    }

    if (deps.visualGate) {
      const visual = await deps.visualGate(sandbox);
      if (visual.verdict === 'fail') {
        return { verdict: 'fail', log: clip(`[visual] ${visual.log}${log}`) };
      }
      log += `\n[visual] ${visual.log}`;
    }

    return { verdict: 'pass', log: clip(log) };
  } finally {
    await rm(target, { force: true }).catch(() => undefined);
    if (stubPath) await rm(stubPath, { force: true }).catch(() => undefined);
  }
}

function clip(s: string): string {
  return s.length > MAX_LOG_CHARS ? `${s.slice(0, MAX_LOG_CHARS)}\n…[truncated]` : s;
}
