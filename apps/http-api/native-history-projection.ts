import { isInternalToolReminder } from '@mcp/code-agent/core/tool-extra-user-messages.js';
import { NativeTaskProjection } from '@mcp/session-storage/native-task-projection.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { create, fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime, agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { replayNativeCommittedEvents, decodeProviderFrontier, adaptProviderRequest,
  DEFAULT_PROVIDER_GATEWAY_LIMITS, NativeSessionAttachments, decodeNativeToolUserMessage,
  type EngineEventRecoveryStorePort } from '@mcp/agent-runtime-host';
import { queryConversationProjection, type FsCoderMessageRow, type FsConversationProjection,
  type FsConversationProjectionQuery } from '@mcp/session-storage/fs-store/index.js';
import type { AgentMessage, ToolResultBlock, ChatUsage } from '@mcp/provider-sdk/wire.js';
import { NativeCoderEventProjection } from './sse/native-coder-events.js';
import { NativeHistoryToolBatch, type NativeHistoryToolResult } from './native-history-tool-batch.js';
import { nativeHistoryOutcome } from './native-history-outcome.js';
import { NativeGoalProjection } from '@mcp/session-storage/native-goal-projection.js';
import { expandContextChapters } from '../../packages/agent-runtime-host/src/native/NativeContextChapters.js';
import { NATIVE_SESSION_MAX_RECORDS } from '../../packages/agent-runtime-host/src/native/NativeSessionStoreLimits.js';

export type NativeHistoryProjection = FsConversationProjection & { usage: {
  total_input_tokens: number; total_output_tokens: number; total_cache_read_tokens: number;
  total_cache_creation_tokens: number; last_turn_input_tokens: number;
} };

/** Incremental, rebuildable projection of receipts validated by the native writer or reader. */
export function createNativeHistoryProjection(sessionId: string, createdAt: string,
  isContinuation?: (attemptId: string) => Promise<boolean>) {
  let messages: AgentMessage[] = [];
  let rows: FsCoderMessageRow[] = [];
  let runtime_outcome: FsConversationProjection['runtime_outcome'];
  const goals = new NativeGoalProjection(sessionId);
  const tasks = new NativeTaskProjection();
  const usage = { total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0, last_turn_input_tokens: 0 };
  let bytes = 0;
  const append = (message: AgentMessage, operationId: string, turnUsage?: ChatUsage) => {
    const seq = messages.length + 1;
    if (seq > 100_000) throw new Error('Native history exceeds message bound');
    const contentJson = JSON.stringify(message.content);
    bytes += Buffer.byteLength(contentJson);
    if (bytes > 64 * 1024 * 1024) throw new Error('Native history projection exceeds byte bound');
    messages.push(message);
    rows.push({ id: `${sessionId}:native:${seq}`, seq, session_id: sessionId as FsCoderMessageRow['session_id'],
      turn_seq: seq, operation_id: operationId, role: message.role, phase: message.phase,
      content_json: contentJson, input_tokens: turnUsage?.input_tokens ?? 0, output_tokens: turnUsage?.output_tokens ?? 0,
      cache_read_tokens: turnUsage?.cache_read_input_tokens ?? 0, cache_creation_tokens: turnUsage?.cache_creation_input_tokens ?? 0, created_at: createdAt,
      is_meta: message.isMeta ? 1 : 0,
      selected_skill_ids_json: message.selectedSkillIds?.length ? JSON.stringify(message.selectedSkillIds) : null, artifact_refs: [] });
    if (turnUsage) {
      usage.total_input_tokens += turnUsage.input_tokens;
      usage.total_output_tokens += turnUsage.output_tokens;
      usage.total_cache_read_tokens += turnUsage.cache_read_input_tokens ?? 0;
      usage.total_cache_creation_tokens += turnUsage.cache_creation_input_tokens ?? 0;
      usage.last_turn_input_tokens = turnUsage.input_tokens;
    }
  };
  const seenAttempts = new Set<string>();
  const attachments = new NativeSessionAttachments(sessionId);
  const seenRuns = new Set<string>();
  const acceptFrontier = async (store: EngineEventRecoveryStorePort, receipt: wire.CommitSessionRecordReceipt, bytes: Uint8Array) => {
    const record = fromBinary(agentV1Runtime.ProviderFrontierRecordV1Schema, bytes);
    const sourceAttempt = record.frontier?.sourceAttemptId;
    if (!sourceAttempt) throw new Error('Native history frontier lacks attempt authority');
    if (!seenAttempts.has(sourceAttempt)) {
      if (seenAttempts.size >= 1024) throw new Error('Native history attempt bound exceeded');
      seenAttempts.add(sourceAttempt);
      const frontier = decodeProviderFrontier(bytes);
      if (frontier.value.sessionId !== sessionId) throw new Error('Native history frontier crosses sessions');
      runtime_outcome = { runtimeGeneration: 'rust_v1', agentRunId: frontier.value.agentRunId,
        attemptId: sourceAttempt, status: 'running' };
      const context = frontier.value.context!;
      const initialMessages = seenRuns.size === 0
        ? await expandContextChapters(store, sessionId, context.messages) : context.messages;
      const request = await adaptProviderRequest(create(agentV1Runtime.ProviderStartSchema, {
        messages: initialMessages, tools: [],
      }), attachments, { ...DEFAULT_PROVIDER_GATEWAY_LIMITS, maxMessages: 100_000,
        maxContentBlocks: 100_000, maxRequestBytes: 16 * 1024 * 1024 }, new AbortController().signal);
      if (context.preparedUserContext) {
        const pinned = context.preparedUserContext.messageIndex;
        const index = initialMessages === context.messages ? pinned
          : (await expandContextChapters(store, sessionId, context.messages.slice(0, pinned))).length;
        request.messages[index]!.selectedSkillIds = [...context.preparedUserContext.selectedSkillIds];
      }
      const runId = frontier.value.agentRunId;
      if (seenRuns.size === 0) {
        for (const message of request.messages) append(message, receipt.operationId);
      } else if (!seenRuns.has(runId) && !await isContinuation?.(sourceAttempt)) {
        // A new product command appends one user input to its prepared context.
        // Older context may be compacted, so it must not replace the transcript.
        const user = request.messages.at(-1);
        if (user?.role !== 'user') throw new Error('New native command has no user input');
        append(user, receipt.operationId);
      }
      seenRuns.add(runId);
    }
  };
  const projections = new Map<string, NativeCoderEventProjection>();
  let extraMessages: Array<{ id: string; name?: string; encoded: string }> = [];
  const toolBatch = new NativeHistoryToolBatch();
  const appendToolResults = (results: NativeHistoryToolResult[]) => {
    for (const data of results) {
      const block: ToolResultBlock = { type: 'tool_result', tool_use_id: data.id,
        content: data.result.content, is_error: data.result.isError,
        ...(data.result.truncated ? { truncated: true, originalSize: data.result.originalSize } : {}),
        ...(data.result.effectOutcome === 'unknown' ? { effect_outcome: 'unknown' as const } : {}) };
      append({ role: 'tool', content: [block] }, data.id);
      if (data.result.extraUserMessageHex) extraMessages.push({ id: data.id, name: data.name, encoded: data.result.extraUserMessageHex });
    }
  };
  const flushExtraMessages = async () => {
    for (const extra of extraMessages.splice(0)) {
      const request = await adaptProviderRequest(create(agentV1Runtime.ProviderStartSchema, {
        messages: [decodeNativeToolUserMessage(extra.encoded)], tools: [],
      }), attachments, DEFAULT_PROVIDER_GATEWAY_LIMITS, new AbortController().signal);
      const message = request.messages[0]!;
      if (isInternalToolReminder(extra.name, message.content)) message.isMeta = true;
      append(message, `${extra.id}:attachments`);
    }
  };
  let cursor = 0n;
  let failed = false;
  let lastSnapshot: { sequence: bigint; value: NativeHistoryProjection } | undefined;
  const snapshot = async (query?: FsConversationProjectionQuery): Promise<NativeHistoryProjection> => {
    const base = { length: messages.length, bytes, extraMessages };
    extraMessages = [...extraMessages];
    try {
      appendToolResults(toolBatch.snapshot());
      await flushExtraMessages();
      const view = { messages, rows, usage: { ...usage }, runtime_outcome, nativeGoal: goals.value, nativeTasks: tasks.value };
      if (query) return { ...queryConversationProjection(view, query), usage: view.usage };
      return { ...view, messages: messages.slice(), rows: rows.slice() };
    } finally {
      messages.length = base.length; rows.length = base.length;
      ({ bytes, extraMessages } = base);
    }
  };
  const consume = async (store: EngineEventRecoveryStorePort,
    query?: FsConversationProjectionQuery): Promise<NativeHistoryProjection> => {
    if (failed) throw new Error('Native history projection requires revalidation after failure');
    let sliceStarted = performance.now();
    try {
      for await (const event of replayNativeCommittedEvents(store, sessionId, cursor, NATIVE_SESSION_MAX_RECORDS, undefined,
        (receipt, bytes) => acceptFrontier(store, receipt, bytes), (receipt, bytes) => attachments.append(receipt, bytes),
        receipt => { cursor = receipt.globalSequence; })) {
        const attemptId = event.record.identity!.attemptId;
        runtime_outcome = nativeHistoryOutcome(runtime_outcome, event.record);
        let projection = projections.get(attemptId);
        if (!projection) {
          if (projections.size >= 1024) throw new Error('Native history attempt bound exceeded');
          projection = new NativeCoderEventProjection((name, raw) => {
            if (name === 'message_complete') {
              const data = raw as { message: AgentMessage; native_provider_operation_id: string; usage?: ChatUsage };
              toolBatch.stage(data.message);
              append(data.message, data.native_provider_operation_id, data.usage);
            } else if (name === 'tool_call_result') {
              const goalResult = raw as { id: string; name: string; result: { nativeGoal?: unknown; nativeTasks?: unknown; isError: boolean } };
              goals.apply(goalResult.result.nativeGoal, goalResult.id, goalResult.name, goalResult.result.isError);
              tasks.apply(goalResult.result.nativeTasks, goalResult.id, goalResult.name, goalResult.result.isError);
              appendToolResults(toolBatch.accept(raw as NativeHistoryToolResult));
            }
          }, attemptId);
          projections.set(attemptId, projection);
        }
        projection.apply(event);
        // All results of a batch precede its synthetic user messages. The next
        // provider start (or terminal on cancel) is a stable transcript boundary.
        if (event.record.body.case === 'providerStarted' || event.record.body.case === 'terminal') {
          await flushExtraMessages();
        }
        if (performance.now() - sliceStarted >= 4) { await yieldToEventLoop(); sliceStarted = performance.now(); }
      }
      if (lastSnapshot?.sequence === cursor) {
        return query ? { ...queryConversationProjection(lastSnapshot.value, query), usage: lastSnapshot.value.usage } : lastSnapshot.value;
      }
      lastSnapshot = undefined;
      const value = await snapshot(query);
      if (!query) lastSnapshot = { sequence: cursor, value };
      return value;
    } catch (error) { failed = true; throw error; }
  };
  return { consume, close: () => attachments.close(), get sequence() { return cursor; } };
}
