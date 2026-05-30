/**
 * One-shot command capability. Spawns an allowlisted binary (no shell → no
 * injection), collects stdout+stderr, resolves { stdout, code } at exit. The
 * binary basename (and, for `npx`, the package basename) must be in the
 * plugin's granted `exec.allow`. Long-running / interactive commands (live
 * `tail`, `wrangler login`) use the UI streaming path, not this.
 *
 * Note: the CALLER resolves platform shims (e.g. `npx.cmd` on Windows); the
 * allowlist matches on basename so `npx` and `npx.cmd` are equivalent.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { PluginPermissions } from '@mcp/plugin-sdk';

export interface ExecResult {
  stdout: string;
  code: number | null;
}

type ExecGrants = PluginPermissions['exec'];

interface ExecPayload {
  cmd?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Strip the binary basename of path + .cmd/.exe/.bat so the allowlist is platform-neutral. */
function baseName(cmd: string): string {
  return (cmd.split(/[/\\]/).pop() ?? cmd).replace(/\.(cmd|exe|bat|ps1)$/i, '');
}

/** Exported for unit tests: is `cmd args` permitted by the allowlist? */
export function isExecAllowed(cmd: string, args: string[], allow: string[] | undefined): boolean {
  if (!allow || allow.length === 0) return false;
  const base = baseName(cmd);
  if (!allow.includes(base)) return false;
  // `npx <pkg>` — the package itself must be allowlisted too.
  if (base === 'npx') {
    const pkg = args.find((a) => !a.startsWith('-'));
    return pkg ? allow.includes(baseName(pkg)) : false;
  }
  return true;
}

/** Drop the dev-only vars our parent injects so child processes behave normally. */
function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MCP_DEV_HTTP;
  delete env.MCP_ELECTRON_DEV_URL;
  return { ...env, ...(extra ?? {}) };
}

export async function handleExec(
  payload: unknown,
  cwd: string,
  grants: ExecGrants | undefined,
): Promise<ExecResult> {
  const { cmd, args = [], env, cwd: subCwd } = (payload ?? {}) as ExecPayload;
  if (!cmd || !isExecAllowed(cmd, args, grants?.allow)) {
    throw new Error(`permission_denied: exec not allowed: ${cmd ?? ''} ${args.join(' ')}`.trim());
  }
  const runCwd = resolve(cwd, subCwd ?? '.');
  return new Promise<ExecResult>((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: runCwd, env: cleanEnv(env), shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ stdout: stderr ? `${stdout}${stdout ? '\n' : ''}${stderr}` : stdout, code });
    });
  });
}
