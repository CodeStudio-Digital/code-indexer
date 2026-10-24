import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import type { FsConversationRuntimeOutcome } from '@mcp/session-storage/fs-store/index.js';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { runtimeRequestId } from './runtime-attempt-ledger.js';

/** Engine read model. Public completion additionally requires product cleanup. */
export function nativeHistoryOutcome(previous: FsConversationRuntimeOutcome | undefined,
  record: wire.EngineEventRecordV1): FsConversationRuntimeOutcome {
  const identity = record.identity!;
  const current: FsConversationRuntimeOutcome = previous?.attemptId === identity.attemptId ? previous : {
    runtimeGeneration: 'rust_v1', agentRunId: identity.agentRunId, attemptId: identity.attemptId, status: 'running',
  };
  if (record.body.case !== 'terminal') return current;
  const terminal = record.body.value;
  const completed = terminal.classification === wire.EngineTerminalClassificationV1.COMPLETED;
  const interrupted = terminal.classification === wire.EngineTerminalClassificationV1.INTERRUPTED;
  // Interrupted does not itself prove user cancellation (it also covers
  // deadlines, provider loss and quotas). The product reader adds that proof.
  return { ...current, status: completed ? 'completed' : interrupted ? 'interrupted' : 'failed',
    reason: terminal.reasonCode };
}

/** Product cancellation can finish after the runner is reaped without a terminal
 * journal receipt. Read that independent authority without rewriting history or
 * treating an outstanding cancel request as proof that execution has stopped. */
export async function resolveNativeProductOutcome(repository: Pick<ControlPlaneFileRepository, 'get'>,
  sessionId: string, current: FsConversationRuntimeOutcome): Promise<FsConversationRuntimeOutcome> {
  if (current.status === 'cancelled') return current;
  const record = await repository.get('run', current.agentRunId);
  const run = record?.data.run as { sessionId?: string; agentRunId?: string; activeAttemptId?: string;
    status?: string; terminalReason?: string; finishedAt?: string } | undefined;
  if (!record || !run || record.relations.session !== sessionId || run.sessionId !== sessionId
    || run.agentRunId !== current.agentRunId) throw new Error('Native history run authority changed');
  // A later attempt may already own the run while this immutable journal
  // snapshot still ends in the previous attempt. Never borrow its terminal.
  if (run.activeAttemptId !== current.attemptId) return current;
  const productTerminal = Boolean(run.finishedAt)
    && ['completed', 'failed', 'aborted', 'interrupted'].includes(run.status ?? '');
  if (!productTerminal) return current.status === 'running' ? current
    : { ...current, status: 'running', reason: 'native_host_cleanup_pending' };
  // Host drain can fail after the engine successfully wrote its terminal.
  // Cancellation or completed text must never hide that independent failure.
  if (run.status === 'failed') return { ...current, status: 'failed', reason: run.terminalReason ?? current.reason };
  if (current.status === 'failed') return current;
  if (current.status === 'completed') return run.status === 'completed' ? current
    : { ...current, status: 'interrupted', reason: run.terminalReason ?? current.reason };
  const cancellation = await repository.get('runtimeRequest', runtimeRequestId(current.attemptId, 'cancel'));
  if (cancellation && (cancellation.relations.session !== sessionId
    || cancellation.relations.attempt !== current.attemptId || cancellation.relations.run !== current.agentRunId
    || cancellation.data.key !== 'cancel' || cancellation.data.checkpointType !== 'runtime-request-v1')) {
    throw new Error('Native history cancellation authority changed');
  }
  if (cancellation && (current.status === 'interrupted' || run.status === 'interrupted' || run.status === 'aborted')) {
    return { ...current, status: 'cancelled', reason: run.terminalReason ?? current.reason ?? 'aborted' };
  }
  if (current.status === 'interrupted') return current;
  // Completion still requires the Rust terminal receipt. Missing proof never
  // upgrades a partially persisted answer to successful completion.
  return { ...current, status: run.status === 'failed' ? 'failed' : 'interrupted',
    reason: run.status === 'completed' ? 'missing_native_terminal_receipt' : run.terminalReason };
}
