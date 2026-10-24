import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader, replayNativeCommittedEvents, type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import type { AgentTreeReconciliation } from '@mcp/code-agent/ports/agent-tree-port.js';
import type { NativeChildCompletionAuthority } from './native-child-reference-authority.js';
import { resolveNativeChildSessionRoot } from './native-child-storage.js';
import { NativeCoderEventProjection } from './sse/native-coder-events.js';

/** Recovery consumes the entire validated child journal. A truncated display
 * transcript, a process exit, or a fenced startup row cannot prove completion. */
export async function reconcileNativeChildJournal(input: { source: NativeChildCompletionAuthority;
  reference: string; rootPath: string; runtimePackage: VerifiedRuntimePackage; signal: AbortSignal;
  assertOwner(): Promise<void> }): Promise<AgentTreeReconciliation> {
  const unknown = (detail: string): AgentTreeReconciliation => ({ outcome: 'outcome_unknown', detail, resultRef: input.reference });
  input.signal.throwIfAborted();
  if (!input.source.physicalReaped || !input.source.hostDrained) return unknown('physical cleanup or Host effect drain is not confirmed');
  const { context } = input.source;
  input.signal.throwIfAborted(); await input.assertOwner();
  const rootPath = await resolveNativeChildSessionRoot(input.rootPath, context);
  const reader = await NativeSessionReader.open(input.runtimePackage, { rootPath, sessionId: context.sessionId });
  try {
    if (reader.state.authority?.writerId !== context.attemptId) throw new Error('Native child recovery has a different journal writer');
    let summary = '';
    const projection = new NativeCoderEventProjection((event, raw) => {
      if (event !== 'message_complete') return;
      const message = (raw as { message?: { content?: { type: string; text?: string }[] } }).message;
      let text = '';
      for (const block of message?.content ?? []) if (block.type === 'text' && block.text) text = (text + block.text.slice(0, 16_384)).slice(0, 16_384);
      if (text) summary = text;
    }, context.attemptId);
    let lastYield = performance.now();
    for await (const entry of replayNativeCommittedEvents(reader.store, context.sessionId, 0n, 100_000, input.signal)) {
      if (entry.record.identity?.agentRunId !== context.agentRunId || entry.record.identity.attemptId !== context.attemptId) {
        throw new Error('Native child recovery contains foreign execution authority');
      }
      projection.apply(entry);
      if (performance.now() - lastYield >= 4) { await yieldToEventLoop(); lastYield = performance.now(); input.signal.throwIfAborted(); }
    }
    projection.finishStream();
    await reader.assertCurrent(); await input.assertOwner(); input.signal.throwIfAborted();
    const terminal = projection.completed;
    if (!terminal || projection.hasUncertainEffects) return unknown('child journal has missing or uncertain effect receipts');
    const interrupted = terminal.classification === wire.EngineTerminalClassificationV1.INTERRUPTED;
    const status = terminal.classification === wire.EngineTerminalClassificationV1.COMPLETED ? 'completed' : interrupted ? 'interrupted' : 'failed';
    if (input.source.status !== status || input.source.reason !== terminal.reasonCode && !(interrupted && input.source.reason === 'aborted')) {
      return unknown('Host completion and committed child terminal do not agree');
    }
    return { outcome: 'terminal', stepStatus: status === 'completed' ? 'completed'
      : interrupted && ['max_turns', 'max_tool_calls', 'ipc_identity_budget'].includes(terminal.reasonCode) ? 'partial' : 'failed',
      reason: terminal.reasonCode, summary: summary || undefined, resultRef: input.reference,
      detail: 'validated complete child journal, physical reap and Host drain' };
  } finally { await reader.close(); }
}
