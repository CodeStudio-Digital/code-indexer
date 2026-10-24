import { agentV1Runtime as runtime } from '@mcp/agent-runtime-contracts';
import { encodeNativeToolUserMessage } from '@mcp/agent-runtime-host';
import { createHash, randomUUID } from 'node:crypto';
import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { expect, it } from 'vitest';
import { agentV1Common, agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { engineRecordStorage } from '../../../packages/agent-runtime-host/src/ipc/EngineContentRecord.js';
import { createNativeHistoryProjection } from '../native-history-projection.js';
import { nativeToolUseId } from '@mcp/agent-runtime-host';
import { NativeCoderEventProjection } from '../sse/native-coder-events.js';

function fixture() {
  const sessionId = randomUUID();
  const identity = create(agentV1Common.AttemptIdentitySchema, { sessionId, commandId: randomUUID(),
    agentRunId: randomUUID(), attemptId: randomUUID(), rootAgentRunId: randomUUID(),
    correlationId: randomUUID(), executorOwnerId: 'host', fencingEpoch: 1n });
  const entries: Array<{ receipt: wire.CommitSessionRecordReceipt; bytes: Uint8Array }> = [];
  const reads = new Set<bigint>();
  const append = (body: MessageInitShape<typeof wire.EngineEventRecordV1Schema>['body']) => {
    const sequence = BigInt(entries.length + 1);
    const record = create(wire.EngineEventRecordV1Schema, { schemaVersion: 1, identity,
      localSequence: sequence, runtimeInstanceId: 'runtime', body });
    const bytes = toBinary(wire.EngineEventRecordV1Schema, record);
    entries.push({ bytes, receipt: create(wire.CommitSessionRecordReceiptSchema, { sessionId,
      operationId: randomUUID(), globalSequence: sequence, ...engineRecordStorage(record),
      payloadBytes: BigInt(bytes.length), payloadSha256: createHash('sha256').update(bytes).digest() }) });
  };
  const content = (kind: wire.EngineContentKindV1, id: string, text: string, operationId = 'provider:1') => {
    const bytes = Buffer.from(text);
    const hash = createHash('sha256').update(bytes).digest();
    append({ case: 'content', value: { kind, contentId: randomUUID(), operationId,
      toolUseId: kind === wire.EngineContentKindV1.TRANSCRIPT ? '' : id, contentSchemaId: kind === wire.EngineContentKindV1.TRANSCRIPT ? 'text/utf8' : 'json',
      contentSchemaVersion: 1, encodedChunk: bytes, totalBytes: BigInt(bytes.length), contentSha256: hash } });
    return { hash, bytes: BigInt(bytes.length) };
  };
  const source = { list: async (after: bigint, maximum: number) => {
    const records = entries.filter(e => e.receipt.globalSequence > after).slice(0, maximum).map(e => e.receipt);
    const nextGlobalSequence = records.at(-1)?.globalSequence ?? after;
    return { records, nextGlobalSequence, complete: nextGlobalSequence === BigInt(entries.length) };
  }, read: async (receipt: wire.CommitSessionRecordReceipt) => {
    if (reads.has(receipt.globalSequence)) throw new Error('old payload was reread');
    reads.add(receipt.globalSequence);
    return entries[Number(receipt.globalSequence) - 1]!.bytes;
  } };
  return { sessionId, identity, append, content, source, entries, reads };
}

it.each([false, true])('preserves authoritative truncation metadata across live projection and replay: %s', async truncated => {
  const f = fixture(), live: unknown[] = [];
  const projection = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
  const events = new NativeCoderEventProjection((name, data) => { if (name === 'tool_call_result') live.push(data); }, f.identity.attemptId);
  f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
  const input = f.content(wire.EngineContentKindV1.TOOL_INPUT, 'read', '{}');
  f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:1', toolUseId: 'read', capabilityName: 'read_file', inputSha256: input.hash } });
  f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: 'read' } });
  // Payload metadata deliberately disagrees: only the committed terminal wins.
  const result = f.content(wire.EngineContentKindV1.TOOL_RESULT, 'read', JSON.stringify({ content: 'partial', isError: false,
    truncated: !truncated, originalSize: 999 }));
  f.append({ case: 'capabilityTerminal', value: { toolUseId: 'read', classification: wire.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
    resultSha256: result.hash, resultBytes: result.bytes, resultSchemaId: 'codestudio.tool-result.v1', resultSchemaVersion: 1,
    truncated, bytesRead: 456n } });
  try {
    for (const entry of f.entries) events.apply({ record: fromBinary(wire.EngineEventRecordV1Schema, entry.bytes), receipt: entry.receipt });
    const snapshot = await projection.consume(f.source), block = snapshot.messages.at(-1)!.content[0]!;
    expect(block).toMatchObject({ type: 'tool_result', content: 'partial' });
    expect(live).toHaveLength(1);
    for (const value of [block, (live[0] as { result: unknown }).result]) {
      expect((value as { truncated?: boolean }).truncated).toBe(truncated ? true : undefined);
      expect((value as { originalSize?: number }).originalSize).toBe(truncated ? 456 : undefined);
    }
    expect(JSON.parse(snapshot.rows.at(-1)!.content_json)[0]).toEqual(block);
  } finally { projection.close(); }
});

it('publishes a failed orchestration board only after its result is confirmed', () => {
  const f = fixture(), published: string[] = [];
  const projection = new NativeCoderEventProjection(event => published.push(event), f.identity.attemptId);
  f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
  const input = f.content(wire.EngineContentKindV1.TOOL_INPUT, 'tasks', '{}');
  f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:1', toolUseId: 'tasks', capabilityName: 'execute_tasks', inputSha256: input.hash } });
  f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: 'tasks' } });
  const result = f.content(wire.EngineContentKindV1.TOOL_RESULT, 'tasks', JSON.stringify({ content: 'One task failed', isError: true,
    nativeTasks: { version: 1, toolUseId: nativeToolUseId(f.identity.attemptId, 'provider:1', 'tasks'), toolName: 'execute_tasks', expected: null, next: null } }));
  for (const entry of f.entries) projection.apply({ record: fromBinary(wire.EngineEventRecordV1Schema, entry.bytes), receipt: entry.receipt });
  expect(published).not.toContain('task_updated');
  f.append({ case: 'capabilityTerminal', value: { toolUseId: 'tasks', classification: wire.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
    resultSha256: result.hash, resultBytes: result.bytes, resultSchemaId: 'codestudio.tool-result.v1', resultSchemaVersion: 1 } });
  const terminal = f.entries.at(-1)!;
  projection.apply({ record: fromBinary(wire.EngineEventRecordV1Schema, terminal.bytes), receipt: terminal.receipt });
  expect(published.filter(name => name === 'task_updated')).toHaveLength(1);
});

it.each(['unknown', 'failed', 'orphan', 'undispatched'] as const)('tracks uncertain effects for %s without confusing a known failure with an orphan', kind => {
  const f = fixture(), projection = new NativeCoderEventProjection(() => {}, f.identity.attemptId);
  f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
  const input = f.content(wire.EngineContentKindV1.TOOL_INPUT, 'write', '{}');
  f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:1', toolUseId: 'write', capabilityName: 'write_file', inputSha256: input.hash } });
  if (kind !== 'undispatched') f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: 'write' } });
  if (kind === 'unknown' || kind === 'failed') f.append({ case: 'capabilityTerminal', value: { toolUseId: 'write',
    classification: kind === 'unknown' ? wire.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN : wire.EngineCapabilityTerminalClassificationV1.FAILED,
    reasonCode: 'connection_lost' } });
  f.append({ case: 'terminal', value: { classification: wire.EngineTerminalClassificationV1.INTERRUPTED, reasonCode: 'cancelled' } });
  for (const entry of f.entries) projection.apply({ record: fromBinary(wire.EngineEventRecordV1Schema, entry.bytes), receipt: entry.receipt });
  expect(projection.hasUncertainEffects).toBe(kind === 'unknown' || kind === 'orphan');
});

it.each(['undispatched', 'started', 'result_bytes', 'cancelled', 'failed'] as const)(
  'retains effect authority on stream closure at %s without requiring a run terminal', kind => {
    const f = fixture(), projection = new NativeCoderEventProjection(() => {}, f.identity.attemptId);
    f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
    const input = f.content(wire.EngineContentKindV1.TOOL_INPUT, 'write', '{}');
    f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:1', toolUseId: 'write', capabilityName: 'write_file', inputSha256: input.hash } });
    if (kind !== 'undispatched') f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: 'write' } });
    if (kind === 'result_bytes') f.content(wire.EngineContentKindV1.TOOL_RESULT, 'write', '{"content":"written"}');
    if (kind === 'cancelled' || kind === 'failed') f.append({ case: 'capabilityTerminal', value: { toolUseId: 'write',
      classification: kind === 'cancelled' ? wire.EngineCapabilityTerminalClassificationV1.CANCELLED : wire.EngineCapabilityTerminalClassificationV1.FAILED,
      reasonCode: kind } });
    for (const entry of f.entries) projection.apply({ record: fromBinary(wire.EngineEventRecordV1Schema, entry.bytes), receipt: entry.receipt });
    expect(projection.completed).toBeUndefined();
    projection.finishStream(); projection.finishStream();
    expect(projection.hasUncertainEffects).toBe(kind === 'started' || kind === 'result_bytes');
    f.append({ case: 'terminal', value: { classification: wire.EngineTerminalClassificationV1.COMPLETED, reasonCode: 'completed' } });
    const late = f.entries.at(-1)!;
    expect(() => projection.apply({ record: fromBinary(wire.EngineEventRecordV1Schema, late.bytes), receipt: late.receipt })).toThrow('stream closure');
  });

it('publishes task state only after a durable terminal and preserves clear across replay', async () => {
  const f = fixture();
  const projection = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
  const state = { gate: 'track', summary: 'Checklist', tasks: [], approved: true, execution_mode: null, current_task_id: null };
  try {
    f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
    const input = f.content(wire.EngineContentKindV1.TOOL_INPUT, 'tasks', '{"todos":[]}');
    f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:1', toolUseId: 'tasks', capabilityName: 'todo_write', inputSha256: input.hash } });
    f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: 'tasks' } });
    const result = f.content(wire.EngineContentKindV1.TOOL_RESULT, 'tasks', JSON.stringify({ content: 'Checklist set', isError: false,
      nativeTasks: { version: 1, toolUseId: nativeToolUseId(f.identity.attemptId, 'provider:1', 'tasks'), toolName: 'todo_write', expected: null, next: state } }));
    expect((await projection.consume(f.source, { kind: 'stats', boundary: 0 })).nativeTasks).toBeUndefined();
    f.append({ case: 'capabilityTerminal', value: { toolUseId: 'tasks', classification: wire.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
      resultSha256: result.hash, resultBytes: result.bytes, resultSchemaId: 'codestudio.tool-result.v1', resultSchemaVersion: 1 } });
    const first = await projection.consume(f.source, { kind: 'stats', boundary: 0 });
    expect(first.nativeTasks).toEqual(state);
    f.append({ case: 'providerStarted', value: { operationId: 'provider:2' } });
    const clearInput = f.content(wire.EngineContentKindV1.TOOL_INPUT, 'clear', '{}', 'provider:2');
    f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:2', toolUseId: 'clear', capabilityName: 'archive_task_list', inputSha256: clearInput.hash } });
    f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: 'clear' } });
    const clear = f.content(wire.EngineContentKindV1.TOOL_RESULT, 'clear', JSON.stringify({ content: 'Cleared', isError: false,
      nativeTasks: { version: 1, toolUseId: nativeToolUseId(f.identity.attemptId, 'provider:2', 'clear'), toolName: 'archive_task_list', expected: state, next: null } }), 'provider:2');
    f.append({ case: 'capabilityTerminal', value: { toolUseId: 'clear', classification: wire.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
      resultSha256: clear.hash, resultBytes: clear.bytes, resultSchemaId: 'codestudio.tool-result.v1', resultSchemaVersion: 1 } });
    expect((await projection.consume(f.source)).nativeTasks).toBeNull();
    expect(first.nativeTasks).toEqual(state);
    const recovered = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
    f.reads.clear();
    try { expect((await recovered.consume(f.source)).nativeTasks).toBeNull(); }
    finally { recovered.close(); }
  } finally { projection.close(); }
});

it('publishes goal state only after the result terminal commits, and recovers it without rereading old payloads', async () => {
  const f = fixture();
  const projection = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
  const goal = { text: 'Keep configuration', status: 'in_progress', budgetTokens: null, completionNote: null,
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
  try {
    f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
    const input = f.content(wire.EngineContentKindV1.TOOL_INPUT, 'goal', JSON.stringify({ goal: goal.text }));
    f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:1', toolUseId: 'goal', capabilityName: 'create_goal', inputSha256: input.hash } });
    f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: 'goal' } });
    const result = f.content(wire.EngineContentKindV1.TOOL_RESULT, 'goal', JSON.stringify({ content: 'Goal set', isError: false,
      nativeGoal: { version: 1, toolUseId: nativeToolUseId(f.identity.attemptId, 'provider:1', 'goal'), toolName: 'create_goal', expected: null, next: goal } }));
    expect((await projection.consume(f.source, { kind: 'stats', boundary: 0 })).nativeGoal).toBeUndefined();
    f.append({ case: 'capabilityTerminal', value: { toolUseId: 'goal', classification: wire.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
      resultSha256: result.hash, resultBytes: result.bytes, resultSchemaId: 'codestudio.tool-result.v1', resultSchemaVersion: 1 } });
    const committed = await projection.consume(f.source, { kind: 'stats', boundary: 0 });
    expect(committed.messages).toEqual([]);
    expect(committed.nativeGoal).toMatchObject({ text: goal.text, status: 'in_progress', revision: 1 });
    expect((await projection.consume(f.source)).nativeGoal).toEqual(committed.nativeGoal);
    const recovered = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
    try {
      f.reads.clear();
      expect((await recovered.consume(f.source)).nativeGoal).toEqual(committed.nativeGoal);
    } finally { recovered.close(); }
  } finally { projection.close(); }
});

it('projects only new receipts across partial, out-of-order batches without changing earlier snapshots', async () => {
  const f = fixture();
  const projection = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
  const result = (id: string) => {
    const content = f.content(wire.EngineContentKindV1.TOOL_RESULT, id, JSON.stringify({ content: id, isError: false }));
    f.append({ case: 'capabilityTerminal', value: { toolUseId: id,
      classification: wire.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
      resultSha256: content.hash, resultBytes: content.bytes, resultSchemaId: 'codestudio.tool-result.v1', resultSchemaVersion: 1 } });
  };
  try {
    f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
    for (const id of ['slow', 'fast']) {
      const content = f.content(wire.EngineContentKindV1.TOOL_INPUT, id, '{}');
      f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:1', toolUseId: id, capabilityName: 'read_file', inputSha256: content.hash } });
    }
    for (const id of ['slow', 'fast']) f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: id } });
    const waiting = await projection.consume(f.source);
    expect(waiting.messages.map(m => m.role)).toEqual(['assistant']);
    result('fast');
    const partial = await projection.consume(f.source);
    expect(partial.messages.map(m => m.role)).toEqual(['assistant', 'tool']);
    expect(JSON.stringify(partial.messages.at(-1))).toContain('fast');
    expect(await projection.consume(f.source)).toBe(partial);
    const partialCount = await projection.consume(f.source, { kind: 'stats', boundary: 0 });
    expect(partialCount.messages).toEqual([]);
    expect(partialCount.selection).toMatchObject({ visibleCount: 2, maxSeq: 2 });
    result('slow');
    const count = await projection.consume(f.source, { kind: 'stats', boundary: 0 });
    expect(count.rows).toEqual([]);
    expect(count.selection!.visibleCount).toBe(3);
    const page = await projection.consume(f.source, { kind: 'tail', boundary: 0, limit: 1 });
    expect(page.messages.map(message => message.role)).toEqual(['assistant', 'tool', 'tool']);
    const settled = await projection.consume(f.source);
    expect(settled.messages.slice(1).map(m => m.content[0])).toMatchObject([
      { type: 'tool_result', content: 'slow' }, { type: 'tool_result', content: 'fast' },
    ]);
    expect(waiting.messages).toHaveLength(1);
    expect(partial.messages).toHaveLength(2);
    expect(partial.rows).toHaveLength(2);
    f.append({ case: 'providerStarted', value: { operationId: 'provider:2' } });
    f.content(wire.EngineContentKindV1.TRANSCRIPT, '', 'Finished', 'provider:2');
    f.append({ case: 'providerCompleted', value: { operationId: 'provider:2' } });
    expect((await projection.consume(f.source)).messages).toHaveLength(4);
    expect(f.reads.size).toBe(f.entries.length);
  } finally { projection.close(); }
});


it('omits an empty assistant when the channel budget stops before opening a provider', async () => {
  const f = fixture();
  const projection = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
  f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
  f.append({ case: 'terminal', value: { classification: wire.EngineTerminalClassificationV1.INTERRUPTED,
    reasonCode: 'ipc_identity_budget' } });
  try {
    const value = await projection.consume(f.source, { kind: 'stats', boundary: 0 });
    expect(value.messages).toEqual([]);
    expect(value.runtime_outcome).toMatchObject({ runtimeGeneration: 'rust_v1', status: 'interrupted', reason: 'ipc_identity_budget' });
  }
  finally { projection.close(); }
});

it.each([
  [wire.EngineTerminalClassificationV1.COMPLETED, 'completed', 'completed'],
  [wire.EngineTerminalClassificationV1.INTERRUPTED, 'cancelled', 'interrupted'],
  [wire.EngineTerminalClassificationV1.INTERRUPTED, 'provider_interrupted', 'interrupted'],
  [wire.EngineTerminalClassificationV1.FAILED, 'provider_failed', 'failed'],
])('rebuilds the durable terminal classification %s/%s', async (classification, reasonCode, status) => {
  const f = fixture();
  const projection = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
  f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
  const active = await projection.consume(f.source);
  expect(active.runtime_outcome?.status).toBe('running');
  f.append({ case: 'terminal', value: { classification, reasonCode } });
  try {
    expect((await projection.consume(f.source)).runtime_outcome).toMatchObject({ status, reason: reasonCode });
    expect(active.runtime_outcome?.status).toBe('running');
  } finally { projection.close(); }
});

it.each(['submit_spec', 'submit_plan', 'ext_server__tool'])('preserves tool instructions and derives visibility for %s on replay', async name => {
  const f = fixture(); const projection = createNativeHistoryProjection(f.sessionId, new Date().toISOString());
  const text = '<system-reminder>Approved internal transition</system-reminder>';
  const encoded = encodeNativeToolUserMessage(create(runtime.ProviderMessageSchema, {
    role: runtime.ProviderMessageRole.USER,
    content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: text } } } }],
  }));
  f.append({ case: 'providerStarted', value: { operationId: 'provider:1' } });
  const input = f.content(wire.EngineContentKindV1.TOOL_INPUT, 'approval', '{}');
  f.append({ case: 'capabilityBoundary', value: { operationId: 'provider:1', toolUseId: 'approval', capabilityName: name, inputSha256: input.hash } });
  f.append({ case: 'capabilityDispatchStarted', value: { toolUseId: 'approval' } });
  const result = f.content(wire.EngineContentKindV1.TOOL_RESULT, 'approval', JSON.stringify({ content: 'Approved', isError: false, extraUserMessageHex: encoded }));
  f.append({ case: 'capabilityTerminal', value: { toolUseId: 'approval', classification: wire.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
    resultSha256: result.hash, resultBytes: result.bytes, resultSchemaId: 'codestudio.tool-result.v1', resultSchemaVersion: 1 } });
  f.append({ case: 'providerStarted', value: { operationId: 'provider:2' } });
  try {
    const first = await projection.consume(f.source);
    const message = first.messages.find(row => row.role === 'user')!;
    expect(message.content).toEqual([{ type: 'text', text }]);
    expect(!!message.isMeta).toBe(name !== 'ext_server__tool');
    const replay = createNativeHistoryProjection(f.sessionId, new Date().toISOString()); f.reads.clear();
    try { expect((await replay.consume(f.source)).messages).toEqual(first.messages); }
    finally { replay.close(); }
  } finally { projection.close(); }
});
