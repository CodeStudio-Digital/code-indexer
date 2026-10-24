import { readFile, realpath } from 'node:fs/promises';
import { parseRuntimePackageAnchor, verifyRuntimePackage, loadNativeHostBridge,
  type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import { prepareNativeWorktree, verifyNativeWorktree } from '@mcp/code-agent/runtime/native-worktree.js';
import type { PreparedWorkspaceInput } from '@mcp/code-agent/runtime/prepared-workspace.js';
import type { CoderAttemptPreparationV1 } from '@mcp/agent-runtime-contracts';
import type { MessageBridge } from '@mcp/orchestrator-host';
import { nativeWorkspaceLeaseGroup } from '../native-workspace-lease-group.js';
import { workerNativeAuthority } from './native-authority-bridge.js';
import type { NativeCoderDevelopmentConfig } from './native-coder-execution.js';
import { NativeShellPort } from './native-shell-port.js';
import { join } from 'node:path';
import type { NativeWorktreeTransition } from '@mcp/code-agent/ports/worktree-transition-port.js';
import { applyNativeWorktreeTransition } from './native-worktree-transition-effect.js';

export async function applyNativeCoderWorktreeTransition(intent: NativeWorktreeTransition,
  config: NativeCoderDevelopmentConfig, bridge: MessageBridge, runId: number, signal: AbortSignal,
  assertOwner: () => void, persist: (path: string | null) => Promise<void>): Promise<string> {
  const store = workerNativeAuthority(bridge, runId, config.context);
  const state = await store.getAttemptState(config.context);
  const deadline = Math.min(Date.now() + 300_000, Date.parse(state.attempt.executorLease.expiresAt));
  if (!samePath(await realpath(intent.projectRoot), await realpath(config.workspaceRoot))) throw new Error('Workspace transition belongs to another project');
  return withShell(config, signal, async (shell, runtimePackage) => {
    const assertCurrent = async () => { assertOwner(); signal.throwIfAborted(); await store.getAttemptState(config.context); assertOwner(); };
    const leases = nativeWorkspaceLeaseGroup(config, runtimePackage);
    // Acquiring the original project also checks that no former worktree
    // writer/child/unknown mutation retains authority anywhere below it.
    const lease = await leases.acquire({ root: config.workspaceRoot, access: 'exclusive_write',
      ownerAgentRunId: config.context.agentRunId, attemptId: config.context.attemptId,
      expiresAtUnixMs: deadline, assertOwner: assertCurrent });
    let uncertain = false;
    try {
      return await applyNativeWorktreeTransition({ intent, shell, signal,
        receiptDirectory: join(config.sessionRoot, config.context.sessionId, 'workspace-transitions'),
        assertCurrent, assertMutation: () => { assertOwner(); signal.throwIfAborted(); leases.assertCurrentForMutation(lease); },
        // The admission helper verified the old durable terminal; the lease
        // acquisition above refused every unreaped previous writer.
        provePreviousAttemptReaped: () => leases.assertCurrent(lease).then(() => undefined), persist });
    } catch (cause) {
      uncertain = (cause as { effectOutcome?: string })?.effectOutcome === 'unknown'; throw cause;
    } finally {
      await shell.close();
      if (!uncertain) await leases.release(lease, () => shell.close());
    }
  }, deadline);
}

export async function prepareNativeCoderWorkspace(input: PreparedWorkspaceInput,
  config: NativeCoderDevelopmentConfig, bridge: MessageBridge, runId: number, assertOwner: () => void): Promise<string> {
  if (!samePath(await realpath(input.projectRoot), await realpath(config.workspaceRoot))) {
    throw new Error('Native worktree preparation belongs to a different project');
  }
  const signal = input.signal ?? new AbortController().signal;
  const store = workerNativeAuthority(bridge, runId, config.context);
  assertOwner(); signal.throwIfAborted();
  const state = await store.getAttemptState(config.context);
  const deadline = Math.min(Date.now() + 300_000, Date.parse(state.attempt.executorLease.expiresAt));
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error('Native worktree preparation authority expired');
  return withShell(config, signal, async (shell, runtimePackage) => {
    const assertCurrent = async () => { assertOwner(); signal.throwIfAborted(); await store.getAttemptState(config.context); assertOwner(); };
    const leases = nativeWorkspaceLeaseGroup(config, runtimePackage);
    const lease = await leases.acquire({ root: input.projectRoot, access: 'exclusive_write',
      ownerAgentRunId: config.context.agentRunId, attemptId: config.context.attemptId,
      expiresAtUnixMs: deadline, assertOwner: assertCurrent });
    try {
      const root = await prepareNativeWorktree(input, shell);
      await assertCurrent();
      return root;
    } finally {
      // No release on unproven process cleanup. A stale writer remains fenced
      // for reconciliation rather than permitting another Git mutation.
      await shell.close();
      await leases.release(lease, () => shell.close());
    }
  }, deadline);
}

export async function verifyNativeCoderWorkspace(config: NativeCoderDevelopmentConfig,
  environment: CoderAttemptPreparationV1['environment'], signal: AbortSignal): Promise<string> {
  const root = await realpath(environment.cwd);
  if (environment.kind === 'host' && samePath(root, await realpath(config.workspaceRoot))) return root;
  if (environment.kind !== 'worktree') throw new Error('Native development cohort requires its owned local workspace');
  return withShell(config, signal, shell => verifyNativeWorktree(config.workspaceRoot, root, shell, signal));
}

async function withShell<T>(config: NativeCoderDevelopmentConfig, signal: AbortSignal,
  operation: (shell: NativeShellPort, runtimePackage: VerifiedRuntimePackage) => Promise<T>,
  deadline = Date.now() + 300_000): Promise<T> {
  if (config.mode !== 'test' || process.platform !== 'win32') throw new Error('Native worktree preparation requires Windows test mode');
  const runtimePackage = await verifyRuntimePackage(config.packageDirectory,
    parseRuntimePackageAnchor(await readFile(config.anchorPath)));
  const start = loadNativeHostBridge(runtimePackage).startNativeHostCommand;
  if (!start) throw new Error('Native package lacks contained Git commands');
  const shell = new NativeShellPort(start, deadline, signal);
  try { return await operation(shell, runtimePackage); } finally { await shell.close(); }
}

function samePath(a: string, b: string) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
