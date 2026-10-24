import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asAgentRunAttemptId } from '@mcp/agent-runtime-contracts';
import { agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader, inspectUnresolvedCapabilityDispatches, parseRuntimePackageAnchor,
  replayNativeCommittedEvents, verifyRuntimePackage, NATIVE_SESSION_MAX_RECORDS } from '@mcp/agent-runtime-host';
import type { NativeWorktreeTransition } from '@mcp/code-agent/ports/worktree-transition-port.js';
import { NativeCoderEventProjection } from '../sse/native-coder-events.js';
import type { NativeCoderDevelopmentConfig } from './native-coder-execution.js';
import { samePath } from './native-worktree-transition-port.js';

/** Only an integrity-checked, successful terminal result can request a switch.
 * The worker's in-memory intent and model arguments are not admission proof. */
export async function readNativeWorktreeTransition(config: NativeCoderDevelopmentConfig, signal: AbortSignal) {
  const result = await readTransition(config, signal, false);
  if (!result) throw new Error('Workspace transition lacks its settled interrupted boundary');
  return result;
}

/** A freshly admitted explicit resume can recover a settled switch before it
 * seals its next cwd. No started/unknown Git effect is replayed by this read. */
export function readPreviousNativeWorktreeTransition(config: NativeCoderDevelopmentConfig, signal: AbortSignal) {
  return readTransition(config, signal, true);
}

/** The native entry point also checks this guard, so bypassing the product
 * wrapper cannot continue a settled switch against the former directory. */
export async function assertNativeWorktreeTransitionMaterialized(config: NativeCoderDevelopmentConfig,
  sourceAttemptId: string, expectedCwd: string, signal: AbortSignal): Promise<void> {
  const { intent } = await readNativeWorktreeTransition({ ...config,
    context: { ...config.context, attemptId: asAgentRunAttemptId(sourceAttemptId) } }, signal);
  const bytes = await readFile(join(config.sessionRoot, config.context.sessionId, 'workspace-transitions', `${intent.id}.json`));
  if (bytes.length > 16 * 1024) throw new Error('Workspace transition receipt exceeds bounds');
  const receipt = JSON.parse(bytes.toString()) as Record<string, unknown>;
  if (receipt.version !== 1 || receipt.phase !== 'confirmed'
    || receipt.intentSha256 !== createHash('sha256').update(JSON.stringify(intent)).digest('hex')
    || JSON.stringify(receipt.intent) !== JSON.stringify(intent) || typeof receipt.cwd !== 'string'
    || !samePath(receipt.cwd, expectedCwd)
    || (intent.action !== 'enter' && !samePath(expectedCwd, intent.projectRoot))) {
    throw new Error('Workspace transition must be confirmed in its intended directory before another attempt');
  }
}

async function readTransition(config: NativeCoderDevelopmentConfig, signal: AbortSignal, previous: boolean) {
  const runtime = await verifyRuntimePackage(config.packageDirectory, parseRuntimePackageAnchor(await readFile(config.anchorPath)));
  const reader = await NativeSessionReader.open(runtime, { rootPath: config.sessionRoot, sessionId: config.context.sessionId });
  try {
    const sourceAttemptId = reader.state.authority?.writerId;
    if (!sourceAttemptId || reader.state.archived || (previous ? sourceAttemptId === config.context.attemptId : sourceAttemptId !== config.context.attemptId)) {
      throw new Error('Workspace transition source writer changed');
    }
    let intent: NativeWorktreeTransition | undefined;
    const projection = new NativeCoderEventProjection((event, payload) => {
      if (event !== 'tool_call_result') return;
      const value = payload as { id: string; name: string; result?: Record<string, unknown> };
      if (!value.result?.nativeWorktreeTransition) return;
      if (intent || value.result.isError) throw new Error('Workspace transition result is ambiguous');
      intent = parseTransition(value.result.nativeWorktreeTransition, value.id, value.name, config.workspaceRoot);
    }, sourceAttemptId);
    for await (const event of replayNativeCommittedEvents(reader.store, config.context.sessionId, 0n, NATIVE_SESSION_MAX_RECORDS, signal)) {
      if (event.record.identity?.attemptId === sourceAttemptId) projection.apply(event);
    }
    projection.finishStream();
    if (previous && projection.completed?.reasonCode !== 'workspace_transition') return undefined;
    if (!intent || projection.hasUncertainEffects || projection.completed?.reasonCode !== 'workspace_transition'
      || projection.completed.classification !== journal.EngineTerminalClassificationV1.INTERRUPTED) throw new Error('Workspace transition lacks its settled interrupted boundary');
    if ((await inspectUnresolvedCapabilityDispatches(reader.store, config.context.sessionId, NATIVE_SESSION_MAX_RECORDS)).length) throw new Error('Workspace transition has unresolved effects');
    await reader.assertCurrent(); return { intent, runtime };
  } finally { await reader.close(); }
}

export function parseTransition(raw: unknown, toolUseId: string, toolName: string, projectRoot: string): NativeWorktreeTransition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw).length > 12 * 1024) throw new Error('Invalid workspace transition');
  const value = raw as NativeWorktreeTransition;
  if (value.version !== 1 || value.toolUseId !== toolUseId || value.toolName !== toolName
    || typeof value.projectRoot !== 'string' || !samePath(value.projectRoot, projectRoot)
    || typeof value.sourceCwd !== 'string' || value.sourceCwd.length > 4096
    || value.id !== createHash('sha256').update(toolUseId).digest('hex')) throw new Error('Workspace transition identity changed');
  if (toolName === 'enter_worktree') {
    if (value.action !== 'enter' || !samePath(value.sourceCwd, projectRoot) || typeof value.name !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value.name)
      || typeof value.branch !== 'string' || !value.branch || value.branch.length > 1024) throw new Error('Invalid enter-worktree transition');
  } else if (toolName !== 'exit_worktree' || !['keep', 'remove'].includes(value.action)
    || samePath(value.sourceCwd, projectRoot) || typeof value.discardChanges !== 'boolean') throw new Error('Invalid exit-worktree transition');
  return structuredClone(value);
}
