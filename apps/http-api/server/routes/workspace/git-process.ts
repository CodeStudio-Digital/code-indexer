import { defaultLocalShellPort, type IShellPort } from '@mcp/code-agent/ports/shell-port.js';

export const MAX_DIFF_BYTES = 500_000;

export const MAX_LOG_BYTES = 100_000;

function port(): IShellPort {
  return defaultLocalShellPort();
}

export async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  const r = await port().run('git', args, {
    cwd,
    encoding: 'utf-8',
    env: env ? { ...process.env, ...env } : undefined,
  });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.exitCode,
  };
}
