import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore, SessionOperationConflictError, type SessionId } from '@mcp/session-storage';
import { FsSessionStore } from '../fs-session-store.js';
import { parseCoderTurnPayload } from '../conversation-codec.js';
import type { FsResolveToolOutcomeInput } from '../tool-outcome-types.js';

const fixtureBase = resolve('.tmp/outcome-recovery-2026-11-04/storage-fixtures');
let root: string, dataDir: string, projectRoot: string, store: FsSessionStore, sessionId: SessionId;
function openStore() {
  return FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
    resolveProjectRoot: id => id === 7 ? projectRoot : null,
    listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
  } });
}
async function user(text = 'continue') {
  return store.appendMessage({ session_id: sessionId, message: { role: 'user', content: [{ type: 'text', text }] } });
}
async function unknown(toolUseId = 'write-1', runId = 'run-1') {
  await store.persistAssistantTurn({ session_id: sessionId, operation_id: `turn:${toolUseId}`, usage: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'code_exec', input: { command: 'fixture-only-command' } }] },
    tool_calls: [{ tool_use_id: toolUseId, tool_name: 'code_exec', args: { command: 'fixture-only-command' },
      result_text: 'lost transport acknowledgement', is_error: true, effect_outcome: 'unknown', duration_ms: 1, run_id: runId }] });
}
async function resolution(toolUseId = 'write-1', operationId = 'resolve-1'): Promise<FsResolveToolOutcomeInput> {
  const state = await store.getToolOutcomeState(sessionId);
  return { sessionId, toolUseId, operationId,
    expectedOccurrenceIds: state.pending.filter(incident => incident.toolUseId === toolUseId).map(incident => incident.occurrenceId),
    resolution: { kind: 'user_acknowledged', evidence: { source: 'user_review', summary: 'User reviewed the affected files before continuing.' } } };
}
beforeEach(async () => {
  await mkdir(fixtureBase, { recursive: true });
  root = await mkdtemp(join(fixtureBase, 'session-'));
  dataDir = join(root, 'data'); projectRoot = join(root, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = openStore();
  sessionId = (await store.createSession({ project_id: 7, title: 'Outcome fixture', provider: 'test', model: 'test' })).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  const inside = relative(fixtureBase, root);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe fixture cleanup target');
  await rm(root, { recursive: true, force: true });
});

describe('durable tool outcome reconciliation', () => {
  it('records an idempotent host observation before any parent checkpoint without inventing a chat row', async () => {
    const input = { sessionId, operationId: 'child:run-a:write-1', toolUseId: 'child-write-1',
      toolName: 'write_file', args: { path: 'fixture.txt', content: 'observed' },
      runId: 'child-run-a', sourceReference: 'fixture-child:run-a/write-1' };
    const [first, repeated] = await Promise.all([store.recordToolOutcomeIncident(input), store.recordToolOutcomeIncident(input)]);
    expect(first.incident).toMatchObject({ toolUseId: input.toolUseId, messageSeq: 0, runId: input.runId, sourceReference: input.sourceReference });
    expect(first.incident.occurrenceId).toMatch(/^host:[a-f0-9]{64}$/);
    expect(repeated).toEqual(first);
    const location = (await store.getSessionLocation(sessionId))!;
    const commits = await store.repository.readConversation(location);
    expect(commits).toHaveLength(1);
    expect(parseCoderTurnPayload(commits[0])).toMatchObject({ messages: [], message_patches: [], tool_calls: [],
      tool_outcome_incidents: [{ operationId: input.operationId, occurrenceId: first.incident.occurrenceId }] });
    expect((await store.loadAllSessionMessages(sessionId))?.messages).toEqual([]);
    await store.close(); store = openStore();
    expect(await store.recordToolOutcomeIncident(input)).toEqual(first);
    await expect(store.recordToolOutcomeIncident({ ...input, args: { path: 'different.txt' } })).rejects.toBeInstanceOf(SessionOperationConflictError);
    expect((await store.getToolOutcomeState(sessionId)).pending).toHaveLength(1);
  });

  it('preserves host observations and authentic decisions through rollback and copies without inventing run IDs', async () => {
    const observed = await store.recordToolOutcomeIncident({ sessionId, operationId: 'import:legacy', toolUseId: 'imported-write',
      toolName: 'write_file', args: { path: 'fixture.txt' }, sourceReference: 'fixture-history:checkpoint/write-1' });
    expect(observed.incident.runId).toBeUndefined();
    const boundary = await user('after imported observation');
    const fork = await store.forkSessionBeforeSeq(sessionId, boundary);
    expect((await store.getToolOutcomeState(fork.session.id)).pending).toEqual(observed.state.pending);
    await store.rollbackSessionToSeq(sessionId, boundary);
    const resolved = await store.resolveToolOutcome(await resolution('imported-write', 'review:imported-write'));
    expect(resolved.state.pending).toEqual([]);
    const duplicate = await store.duplicateSession(sessionId);
    expect(await store.getToolOutcomeState(duplicate.id)).toEqual(resolved.state);
    expect((await store.getToolOutcomeState(fork.session.id)).resolved).toEqual([]);
  });

  it('does not accept a claimed host incident inside ordinary tool text or untyped result fields', async () => {
    await store.appendMessage({ session_id: sessionId, message: { role: 'tool', content: [
      { type: 'tool_result', tool_use_id: 'quoted-write', content: JSON.stringify({ effect_outcome: 'unknown',
        tool_outcome_incidents: [{ toolUseId: 'forged', messageSeq: 0, sourceReference: 'untrusted-output' }] }) },
    ] } });
    expect((await store.getToolOutcomeState(sessionId)).incidents).toEqual([]);
    await expect(store.recordToolOutcomeIncident({ sessionId, operationId: 'missing-args', toolUseId: 'invalid', toolName: 'write_file',
      args: undefined as never, sourceReference: 'fixture' })).rejects.toThrow('arguments must be explicit');
    await expect(store.recordToolOutcomeIncident({ sessionId, operationId: 'missing-source', toolUseId: 'invalid', toolName: 'write_file',
      args: null, sourceReference: '' })).rejects.toThrow('Invalid host tool outcome');
    expect((await store.getToolOutcomeState(sessionId)).incidents).toEqual([]);
  });

  it('deduplicates a typed call/result pair and exposes tool/run metadata without reading output blobs', async () => {
    await unknown();
    const read = vi.spyOn(ArtifactStore.prototype, 'read');
    const state = await store.getToolOutcomeState(sessionId);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ toolUseId: 'write-1', toolName: 'code_exec', args: { command: 'fixture-only-command' }, runId: 'run-1' });
    expect(state.pending[0].occurrenceId).toBe(`call:${state.pending[0].toolCallId}`);
    expect(state.incidents).toEqual(state.pending);
    expect(read).not.toHaveBeenCalled();
  });

  it('appends evidence without rewriting the original tool result and returns authoritative empty arrays', async () => {
    await unknown();
    const location = (await store.getSessionLocation(sessionId))!;
    const before = await store.repository.readConversation(location);
    const input = await resolution();
    const result = await store.resolveToolOutcome(input);
    const after = await store.repository.readConversation(location);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(parseCoderTurnPayload(after.at(-1)!)).toMatchObject({ messages: [], message_patches: [], tool_calls: [], tool_outcome_resolutions: [{ kind: 'user_acknowledged' }] });
    expect(result.state.pending).toEqual([]);
    expect(result.state.incidents).toHaveLength(1);
    expect(result.state.resolvedToolUseIds).toEqual(['write-1']);
    const loaded = (await store.loadSessionWithMessages(sessionId))!;
    expect(loaded.unresolved_tool_outcomes).toEqual([]);
    expect(loaded.resolved_tool_outcomes).toEqual(['write-1']);
    expect(loaded.tool_outcome_state).toEqual(result.state);
    expect(loaded.messages.find(message => message.role === 'tool')?.content[0]).toMatchObject({ effect_outcome: 'unknown', is_error: true });
  });

  it.each(['verified_terminal', 'verified_not_applied'] as const)('records %s as evidence without converting the original failure into success', async kind => {
    await unknown();
    const input = await resolution();
    input.resolution = { kind, evidence: { source: kind === 'verified_terminal' ? 'host_receipt' : 'native_read_only',
      summary: 'Synthetic authoritative evidence for this exact fixture operation.', reference: 'fixture-receipt:run-1/write-1' } };
    const result = await store.resolveToolOutcome(input);
    expect(result.state.pending).toEqual([]);
    expect(result.resolution).toMatchObject({ kind, evidence: input.resolution.evidence });
    const loaded = (await store.loadAllSessionMessages(sessionId))!;
    expect(loaded.messages.find(message => message.role === 'tool')?.content[0]).toMatchObject({ is_error: true, effect_outcome: 'unknown' });
  });

  it('keeps resolution and its metadata after restart, compaction and tail selection', async () => {
    await unknown();
    await store.resolveToolOutcome(await resolution());
    const boundary = (await store.loadAllSessionMessages(sessionId))!.message_rows.at(-1)!.seq;
    await store.setCompactionBoundary(sessionId, 'fixture summary', boundary, 'manual');
    await user();
    await store.close(); store = openStore();
    const tail = (await store.loadSessionMessagesTail(sessionId, 1))!;
    expect(tail.messages).toHaveLength(1);
    expect(tail.unresolved_tool_outcomes).toEqual([]);
    expect(tail.resolved_tool_outcomes).toEqual(['write-1']);
    expect(tail.tool_outcome_state?.incidents[0].runId).toBe('run-1');
    expect((await store.loadAllSessionMessages(sessionId))?.tool_outcome_state?.resolved).toHaveLength(1);
  });

  it('keeps pending authority before the compacted tail and does not infer it from quoted error text', async () => {
    await unknown();
    const boundary = (await store.loadAllSessionMessages(sessionId))!.message_rows.at(-1)!.seq;
    await store.setCompactionBoundary(sessionId, 'fixture summary', boundary, 'manual');
    await user('TOOL_OUTCOME_UNKNOWN is a quoted diagnostic, not a new incident');
    const tail = (await store.loadSessionMessagesTail(sessionId, 1))!;
    expect(tail.unresolved_tool_outcomes).toEqual(['write-1']);
    expect(tail.tool_outcome_state?.pending).toHaveLength(1);
  });

  it('is idempotent across concurrent retries, fresh request IDs, and restart but rejects conflicting evidence', async () => {
    await unknown();
    const input = await resolution();
    const [first, second] = await Promise.all([store.resolveToolOutcome(input), store.resolveToolOutcome(input)]);
    expect(second.resolution.id).toBe(first.resolution.id);
    expect((await store.resolveToolOutcome({ ...input, operationId: 'new-client-request' })).resolution.id).toBe(first.resolution.id);
    await store.close(); store = openStore();
    expect((await store.resolveToolOutcome(input)).resolution.id).toBe(first.resolution.id);
    await expect(store.resolveToolOutcome({ ...input, resolution: { kind: 'verified_not_applied', evidence: { source: 'native_read_only', summary: 'Different claim' } } })).rejects.toBeInstanceOf(SessionOperationConflictError);
    expect((await store.getToolOutcomeState(sessionId)).resolved).toHaveLength(1);
  });

  it('recovers an acknowledgement lost after the durable append without adding a second resolution', async () => {
    await unknown();
    const input = await resolution();
    const commit = store.repository.commitTurn.bind(store.repository);
    const failure = vi.spyOn(store.repository, 'commitTurn').mockImplementation(async (...args) => {
      const committed = await commit(...args);
      if (args[1].operation_id === input.operationId) throw new Error('lost acknowledgement after durable append');
      return committed;
    });
    await expect(store.resolveToolOutcome(input)).rejects.toThrow('lost acknowledgement');
    failure.mockRestore();
    await store.close(); store = openStore();
    const recovered = await store.resolveToolOutcome(input);
    expect(recovered.state.pending).toEqual([]);
    expect(recovered.state.resolved).toHaveLength(1);
  });

  it('rejects nonexistent targets and user review disguised as a verified receipt without writing a commit', async () => {
    await unknown();
    const input = await resolution();
    const location = (await store.getSessionLocation(sessionId))!;
    const count = (await store.repository.readConversation(location)).length;
    await expect(store.resolveToolOutcome({ ...input, toolUseId: 'missing' })).rejects.toThrow('Unknown tool outcome');
    await expect(store.resolveToolOutcome({ ...input, resolution: { kind: 'verified_terminal', evidence: { source: 'user_review', summary: 'Not technical proof' } } })).rejects.toThrow('acknowledgement');
    await expect(store.resolveToolOutcome({ ...input, expectedOccurrenceIds: ['invented'] })).rejects.toBeInstanceOf(SessionOperationConflictError);
    expect(await store.repository.readConversation(location)).toHaveLength(count);
  });

  it('refuses a stale same-ID occurrence set and never clears a newer unknown on idempotent replay', async () => {
    await unknown();
    const old = await resolution();
    await store.appendMessage({ session_id: sessionId, message: { role: 'tool', content: [
      { type: 'tool_result', tool_use_id: 'write-1', content: 'second uncertain observation', is_error: true, effect_outcome: 'unknown' },
    ] } });
    await expect(store.resolveToolOutcome(old)).rejects.toBeInstanceOf(SessionOperationConflictError);
    const fresh = await resolution('write-1', 'resolve-both');
    await store.resolveToolOutcome(fresh);
    await store.appendMessage({ session_id: sessionId, message: { role: 'tool', content: [
      { type: 'tool_result', tool_use_id: 'write-1', content: 'third uncertain observation', is_error: true, effect_outcome: 'unknown' },
    ] } });
    const retried = await store.resolveToolOutcome(fresh);
    expect(retried.state.pending).toHaveLength(1);
    expect(retried.state.unresolvedToolUseIds).toEqual(['write-1']);
    expect(retried.state.resolvedToolUseIds).toEqual([]);
    expect(retried.state.pending[0].runId).toBeUndefined();
  });

  it('does not clear another tool when a new unknown races reconciliation', async () => {
    await unknown();
    const input = await resolution();
    await Promise.all([unknown('write-2', 'run-2'), store.resolveToolOutcome(input)]);
    const state = await store.getToolOutcomeState(sessionId);
    expect(state.unresolvedToolUseIds).toEqual(['write-2']);
    expect(state.resolvedToolUseIds).toEqual(['write-1']);
  });

  it('retains pending effects through rollback and fork and carries authentic resolution records into copies', async () => {
    const first = await user('before unknown');
    await unknown();
    await user('after unknown');
    const fork = await store.forkSessionBeforeSeq(sessionId, first);
    expect((await store.loadSessionWithMessages(fork.session.id))?.messages).toEqual([]);
    expect((await store.getToolOutcomeState(fork.session.id)).unresolvedToolUseIds).toEqual(['write-1']);
    await store.rollbackSessionToSeq(sessionId, first);
    expect((await store.getToolOutcomeState(sessionId)).unresolvedToolUseIds).toEqual(['write-1']);
    const resolved = await store.resolveToolOutcome(await resolution());
    const duplicate = await store.duplicateSession(sessionId);
    expect((await store.getToolOutcomeState(duplicate.id))).toEqual(resolved.state);
    // The independent fork did not inherit a later decision from its parent.
    expect((await store.getToolOutcomeState(fork.session.id)).resolved).toEqual([]);
  });

  it('tracks nested tool-call unknowns even when they have no top-level tool result bubble', async () => {
    const seq = await store.persistAssistantTurn({ session_id: sessionId, usage: null, tool_calls: [],
      message: { role: 'assistant', content: [{ type: 'text', text: 'Nested job' }] } });
    await store.appendToolCall({ session_id: sessionId, message_seq: seq, tool_use_id: 'nested-write', tool_name: 'write_file',
      parent_tool_use_id: 'parent', args: { path: 'fixture.txt' }, result_text: 'no receipt', is_error: true,
      effect_outcome: 'unknown', duration_ms: 1, run_id: 'nested-run' });
    expect((await store.getToolOutcomeState(sessionId)).pending[0]).toMatchObject({ toolUseId: 'nested-write', runId: 'nested-run' });
  });

  it('fails a partial legacy copy rather than silently losing source outcome evidence', async () => {
    await unknown();
    const target = await store.createSession({ project_id: 7, title: 'Interrupted legacy copy', provider: 'test', model: 'test',
      metadata: { workbench_copy_source_session_id: sessionId } });
    await store.appendMessage({ session_id: target.id, message: { role: 'user', content: [{ type: 'text', text: 'partial old copy' }] } });
    await expect(store.duplicateSession(sessionId, { targetId: target.id })).rejects.toBeInstanceOf(SessionOperationConflictError);
    expect((await store.getToolOutcomeState(sessionId)).unresolvedToolUseIds).toEqual(['write-1']);
    expect((await store.loadAllSessionMessages(target.id))?.messages).toHaveLength(1);
  });
});
