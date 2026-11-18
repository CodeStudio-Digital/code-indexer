/**
 * Preflight orchestrator — runs every host check and assembles a report.
 *
 * Host checks run concurrently. Each check is wrapped so one failing
 * probe degrades to a single `error` result instead of throwing the whole
 * report — first-run must always render something actionable.
 */
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { checkGit, checkDisk } from './checks-platform.js';
import type { CheckId, CheckResult, PreflightDeps, PreflightReport } from './types.js';

async function safe(id: CheckId, label: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return { id, label, status: 'error', blocking: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const shell = deps.shell ?? defaultLocalShellPort();
  const platform = process.platform;

  const checks = await Promise.all([
    safe('git', 'Git', () => checkGit(shell)),
    safe('disk', 'Disk space', () => checkDisk(deps.dbPath)),
  ]);
  const blocked = checks.some((c) => c.blocking && (c.status === 'missing' || c.status === 'error'));
  return { platform, ok: !blocked, blocked, checks, generatedAt: new Date().toISOString() };
}
