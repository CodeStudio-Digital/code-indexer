import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson, fsyncDirectory } from '@mcp/session-storage/atomic-file.js';
import { createProjectWorktree, worktreeGit } from '@mcp/code-agent/tools/worktree-operations.js';
import { verifyNativeWorktree } from '@mcp/code-agent/runtime/native-worktree.js';
import type { NativeWorktreeTransition } from '@mcp/code-agent/ports/worktree-transition-port.js';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { samePath } from './native-worktree-transition-port.js';

type Receipt = { version: 1; intent: NativeWorktreeTransition; intentSha256: string; phase: 'started' | 'confirmed'; cwd?: string };

/** Caller holds the NEW attempt's exclusive project lease. A started receipt
 * is never replayed: even local Git can finish before its acknowledgement is
 * lost. A confirmed receipt can only restore metadata, after verifying disk. */
export async function applyNativeWorktreeTransition(input: {
  intent: NativeWorktreeTransition; receiptDirectory: string; shell: IShellPort; signal: AbortSignal;
  assertCurrent(): Promise<void>; assertMutation(): void; provePreviousAttemptReaped(): Promise<void>;
  persist(path: string | null): Promise<void>;
}): Promise<string> {
  const { intent, shell, signal } = input;
  const check = async () => { signal.throwIfAborted(); await input.assertCurrent(); signal.throwIfAborted(); };
  await check(); await input.provePreviousAttemptReaped(); await check();
  const project = await realpath(intent.projectRoot);
  if (!samePath(project, intent.projectRoot)) throw new Error('Workspace transition project root changed');
  if (!/^[a-f0-9]{64}$/.test(intent.id)) throw new Error('Invalid workspace transition receipt id');
  await mkdir(input.receiptDirectory, { recursive: true });
  const receiptPath = join(input.receiptDirectory, `${intent.id}.json`);
  const intentSha256 = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  let previous: Receipt | undefined;
  try {
    const bytes = await readFile(receiptPath);
    if (bytes.byteLength > 16 * 1024) throw new Error('Workspace transition receipt exceeds bounds');
    previous = JSON.parse(bytes.toString()) as Receipt;
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw uncertain(`Workspace transition receipt cannot be verified: ${String(cause)}`); }
  if (previous) {
    if (previous.version !== 1 || previous.intentSha256 !== intentSha256
      || JSON.stringify(previous.intent) !== JSON.stringify(intent)) throw uncertain('Workspace transition receipt differs from its durable intent');
    if (previous.phase !== 'confirmed' || !previous.cwd) throw uncertain();
    const cwd = intent.action === 'enter' ? await verifyNativeWorktree(project, previous.cwd, shell, signal) : project;
    if (!samePath(cwd, previous.cwd)) throw new Error('Confirmed workspace transition target changed');
    if (intent.action === 'remove') {
      try { await stat(intent.sourceCwd); throw new Error('Removed worktree reappeared; reconcile before continuing'); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    }
    await check(); await input.persist(intent.action === 'enter' ? cwd : null); return cwd;
  }

  // Validate all known refusal conditions before committing started.
  if (intent.action === 'enter') {
    if (!samePath(intent.sourceCwd, project) || !intent.name || !intent.branch) throw new Error('Invalid enter-worktree boundary');
    const branch = await worktreeGit(['check-ref-format', '--branch', intent.branch], project, { shell, signal });
    if (!branch.ok) throw new Error(branch.error);
  } else {
    await verifyNativeWorktree(project, intent.sourceCwd, shell, signal);
    if (intent.action === 'remove' && !intent.discardChanges) {
      const status = await worktreeGit(['status', '--porcelain'], intent.sourceCwd, { shell, signal });
      if (!status.ok) throw new Error(status.error);
      if (status.out) throw new Error('Worktree has uncommitted changes; keep it or explicitly authorize discard_changes.');
      // Preserve commits that have not reached the original project's HEAD.
      const base = await worktreeGit(['rev-parse', 'HEAD'], project, { shell, signal });
      if (!base.ok) throw new Error(base.error);
      const ahead = await worktreeGit(['rev-list', '--count', `${base.out}..HEAD`], intent.sourceCwd, { shell, signal });
      if (!ahead.ok || !/^\d+$/.test(ahead.out) || Number(ahead.out) > 0) throw new Error('Worktree has commits absent from the original branch; keep it or explicitly authorize discard_changes.');
    }
  }
  await check(); input.assertMutation();
  const receipt: Receipt = { version: 1, intent, intentSha256, phase: 'started' };
  let cwd = project;
  try {
  const file = await open(receiptPath, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(receipt)); await file.sync(); } finally { await file.close(); }
  await fsyncDirectory(input.receiptDirectory);
  await check(); input.assertMutation();
  if (intent.action === 'enter') {
    const result = await createProjectWorktree(project, { name: intent.name, branch: intent.branch }, { shell, signal });
    if (!result.ok) throw result.outcomeUnknown ? uncertain(result.error) : new Error(result.error);
    cwd = await verifyNativeWorktree(project, result.path, shell, signal);
  } else if (intent.action === 'remove') {
    const result = await worktreeGit(['worktree', 'remove', ...(intent.discardChanges ? ['--force'] : []), '--', intent.sourceCwd], project, { shell, signal }, true);
    if (!result.ok) throw result.outcomeUnknown ? uncertain(result.error) : new Error(result.error);
  }
  await check();
  await atomicWriteJson(receiptPath, { ...receipt, phase: 'confirmed', cwd }, { beforePublish: input.assertMutation });
  } catch (cause) { throw uncertain(`Workspace transition requires reconciliation: ${String(cause)}`); }
  await check(); await input.persist(intent.action === 'enter' ? cwd : null);
  return cwd;
}

function uncertain(message = 'Workspace transition was started without a confirmed outcome. Automatic Git replay is forbidden.') {
  return Object.assign(new Error(message), { code: 'TOOL_OUTCOME_UNKNOWN', effectOutcome: 'unknown' });
}
