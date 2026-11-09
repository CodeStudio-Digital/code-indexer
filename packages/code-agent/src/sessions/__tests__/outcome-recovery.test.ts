import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';
import { createSessionOutcomeRecovery } from '../outcome-recovery.js';
import { PermissionGate } from '../../core/permission-gate.js';
import { needsOutcomeRecoveryApproval } from '../../core/uncertain-tool-outcome.js';
import { toolOutcomeInputHash, type ToolOutcomeTerminalReceipt } from '../../core/tool-outcome-observer.js';
import type { CoderTool } from '../../core/tool.js';
import { BootstrapNode } from '../../core/runner/nodes/bootstrap.js';
import { makeTestContext } from '../../core/runner/nodes/__tests__/test-helpers.js';
import { runBehaviorTree } from '../../core/runner/orchestrator.js';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { ok, unknownToolOutcome, type ToolResult, type NestedToolCallRecord } from '../../core/tool.js';
import { buildCodeExecTool } from '../../tools/code-exec.js';

let root: string, store: FsSessionStore, session: FsCoderSession;
const tool: CoderTool = { name: 'edit_file', source: 'native', description: 'fixture', mutates: true,
  riskLevel: 'write', parameters: { type: 'object', properties: {} }, handler: async () => ({ content: 'done' }) };
const input = { path: 'a.ts', old_string: 'a', new_string: 'b' };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'outcome-recovery-'));
  const project = join(root, 'project'); await mkdir(project);
  store = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: id => id === 7 ? project : null,
    listProjectRoots: () => [{ project_id: 7, root_path: project }],
  } });
  session = await store.createSession({ project_id: 7, title: 'fixture', provider: 'test', model: 'test' });
});
afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

async function unknown(id = 'old', runId = 'original-run', args = input) {
  await store.persistAssistantTurn({ session_id: session.id, operation_id: `fixture:${randomUUID()}`, usage: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool.name, input: args }] },
    tool_calls: [{ tool_use_id: id, tool_name: tool.name, args, result_text: 'lost acknowledgement',
      effect_outcome: 'unknown', run_id: runId, duration_ms: 10, is_error: true }],
  });
}
const controller = () => createSessionOutcomeRecovery({ store, sessionId: session.id });

it('commits typed nested incidents before a different wrapper can replay the same uncertain effect', async () => {
  const recovery = await controller(); const registry = new ToolRegistry();
  const effect = vi.fn(async () => unknownToolOutcome('lost ACK'));
  registry.register({ ...tool, name: 'fixture_effect', handler: effect });
  registry.register(buildCodeExecTool(registry));
  const wait = vi.fn(async () => JSON.stringify({ approved: false }));
  let calls = 0, commits = 0;
  const { ctx, recordedEvents } = makeTestContext({ registry, toolContext: {
    cwd: root, projectName: 'fixture', toolCallLedger: new ToolCallLedger(), outcomeRecovery: recovery.state,
    permissionGate: new PermissionGate({ getMode: () => 'unrestricted', emit: vi.fn(), waitForUserInput: wait }),
    commitToolOutcomeRecovery: async () => {
      for (const record of recordedEvents.filter(e => e.event === 'nested_tool_call')) {
        const e = record.args[0] as NestedToolCallRecord;
        if (e.effectOutcome !== 'unknown') continue;
        await recovery.state.registerIncident!({ toolUseId: e.invocationId, toolName: e.name, args: e.args,
          runId: 'nested-continuation', sourceReference: `fixture:${e.invocationId}` });
        commits++;
      }
    },
  }, provider: { name: 'fixture', model: 'fixture', setModel() {}, async *chat() {
    calls++;
    if (calls > 1) expect(commits).toBe(1);
    if (calls === 3) { yield { type: 'text_delta', text: 'Original effect retained; refused blind replay.' }; yield { type: 'done', stop_reason: 'end_turn' }; return; }
    yield { type: 'tool_call_start', id: `wrapper-${calls}`, name: 'code_exec' };
    yield { type: 'tool_call_end', id: `wrapper-${calls}`, name: 'code_exec', input: {
      code: `${calls === 1 ? '' : '// a different script\n'}return await tools.fixture_effect({});`,
    } };
    yield { type: 'done', stop_reason: 'tool_use' };
  } } });
  const result = await runBehaviorTree({ runId: 'nested-continuation', opts: ctx.opts, emit: ctx.emit, initialTiers: null });
  expect(result.reason).toBe('completed'); expect(calls).toBe(3);
  expect(commits).toBe(1); expect(effect).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledOnce();
});

it('continues a timed-out write with reads, reconciles its late receipt, and admits new authorized work', async () => {
  const recovery = await controller();
  const runId = 'continuous-run';
  const registry = new ToolRegistry();
  const wait = vi.fn(async () => JSON.stringify({ approved: false }));
  let finish!: (result: ToolResult) => void;
  const raw = new Promise<ToolResult>(resolve => { finish = resolve; });
  const effect = vi.fn(async () => raw), next = vi.fn(async () => ok('new authorized work'));
  registry.register({ ...tool, name: 'slow_write', timeoutMs: 20, handler: effect });
  registry.register({ ...tool, name: 'next_write', handler: next });
  registry.register({ ...tool, name: 'inspect', mutates: false, parallelSafe: true, riskLevel: 'read',
    handler: async () => {
      finish(ok('original write completed'));
      await new Promise(resolve => setTimeout(resolve, 10));
      await recovery.state.refresh?.();
      return ok('inspected current files');
    } });
  let calls = 0;
  const { ctx } = makeTestContext({ registry, toolContext: {
    cwd: root, projectName: 'fixture', sessionId: session.id,
    toolCallLedger: new ToolCallLedger(), outcomeRecovery: recovery.state,
    onToolOutcomeTerminal: receipt => recovery.observe(receipt, runId),
    permissionGate: new PermissionGate({ getMode: () => 'unrestricted', emit: vi.fn(), waitForUserInput: wait }),
  }, provider: { name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
    calls++;
    if (calls === 2) {
      expect(request.system).toContain('<tool-outcome-recovery>');
      expect(recovery.state.toolUseIds).toContain('live-1');
    }
    if (calls >= 4) { yield { type: 'text_delta', text: 'Verified and continued.' }; yield { type: 'done', stop_reason: 'end_turn' }; return; }
    const name = ['slow_write', 'inspect', 'next_write'][calls - 1]!;
    yield { type: 'tool_call_start', id: `live-${calls}`, name };
    yield { type: 'tool_call_end', id: `live-${calls}`, name, input: {} };
    yield { type: 'done', stop_reason: 'tool_use' };
  } } });
  try {
    const result = await runBehaviorTree({ runId, opts: ctx.opts, emit: ctx.emit, initialTiers: null });
    expect(result.reason).toBe('completed'); expect(calls).toBe(4);
    expect(effect).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
    expect(recovery.state.toolUseIds).toEqual([]);
    expect(recovery.state.resolvedToolUseIds).toContain('live-1');
    // Persisting the chat after a fast late receipt must not revive the incident.
    await store.persistAssistantTurn({ session_id: session.id, operation_id: 'late-transcript', usage: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'live-1', name: 'slow_write', input: {} }] },
      tool_calls: [{ tool_use_id: 'live-1', tool_name: 'slow_write', args: {}, result_text: 'timed out',
        effect_outcome: 'unknown', run_id: runId, duration_ms: 20, is_error: true }],
    });
    await recovery.historyCommitted();
    expect((await store.getToolOutcomeState(session.id)).unresolvedToolUseIds).toEqual([]);
  } finally { finish(ok('cleanup')); await recovery.drain(); }
});
function receipt(patch: Partial<ToolOutcomeTerminalReceipt> = {}): ToolOutcomeTerminalReceipt {
  return { version: 1, toolUseId: 'old', toolName: tool.name, invocationId: randomUUID(),
    inputHash: toolOutcomeInputHash(input), completedAt: new Date().toISOString(), outcome: 'confirmed', source: 'registry', ...patch };
}

it('records one explicit review in auto mode and preserves the original result across reload', async () => {
  await unknown(); const recovery = await controller();
  const snapshot = recovery.state.snapshot!();
  const wait = vi.fn(async () => JSON.stringify({ approved: true, recoveryReviewed: true, recoveryFingerprint: snapshot.fingerprint }));
  const gate = new PermissionGate({ getMode: () => 'auto', emit: vi.fn(), waitForUserInput: wait });
  const request = { toolUseId: 'new', toolName: tool.name, tool, input: { ...input, path: 'different.ts' }, outcomeRecovery: recovery.state };
  expect(await gate.check(request)).toEqual({ allowed: true });
  expect(await gate.check({ ...request, toolUseId: 'next' })).toEqual({ allowed: true });
  expect(wait).toHaveBeenCalledTimes(1);
  const reloaded = await controller();
  expect(reloaded.state.toolUseIds).toEqual([]);
  expect(reloaded.state.resolvedToolUseIds).toEqual(['old']);
  expect((await store.loadSessionWithMessages(session.id))!.messages.some(message => message.content.some(block => block.type === 'tool_result' && block.effect_outcome === 'unknown'))).toBe(true);
  expect(needsOutcomeRecoveryApproval(reloaded.state, tool, input)).toBe(true);
  expect(needsOutcomeRecoveryApproval(reloaded.state, tool, { ...input, path: 'different.ts' })).toBe(false);
});

it('does not grant a database write or override ask mode after recovery', async () => {
  await unknown(); const recovery = await controller(); await recovery.state.snapshot!().acknowledge!();
  for (const mode of ['ask', 'unrestricted'] as const) {
    const wait = vi.fn(async () => JSON.stringify({ approved: true }));
    const gate = new PermissionGate({ getMode: () => mode, emit: vi.fn(), waitForUserInput: wait });
    const name = mode === 'ask' ? tool.name : 'db_query';
    await gate.check({ toolUseId: 'next', toolName: name, tool: { ...tool, name }, input: { sql: 'DELETE FROM fixture' }, outcomeRecovery: recovery.state });
    expect(wait).toHaveBeenCalledOnce();
  }
});

it('execute once leaves pending evidence and does not restore session authority', async () => {
  await unknown(); const recovery = await controller();
  const wait = vi.fn(async () => JSON.stringify({ approved: true }));
  const gate = new PermissionGate({ getMode: () => 'unrestricted', emit: vi.fn(), waitForUserInput: wait });
  for (const id of ['first', 'second']) await gate.check({ toolUseId: id, toolName: tool.name, tool, input, outcomeRecovery: recovery.state });
  expect(wait).toHaveBeenCalledTimes(2); expect(recovery.state.toolUseIds).toEqual(['old']);
});

it('refuses a review with a stale fingerprint without committing it', async () => {
  await unknown(); const recovery = await controller();
  const gate = new PermissionGate({ getMode: () => 'unrestricted', emit: vi.fn(),
    waitForUserInput: async () => JSON.stringify({ approved: true, recoveryReviewed: true, recoveryFingerprint: 'stale' }) });
  expect(await gate.check({ toolUseId: 'new', toolName: tool.name, tool, input, outcomeRecovery: recovery.state })).toMatchObject({ allowed: false });
  expect(recovery.state.toolUseIds).toEqual(['old']);
});

it('does not dispatch when durable review fails', async () => {
  await unknown(); const recovery = await controller(); const snapshot = recovery.state.snapshot!();
  vi.spyOn(store, 'resolveToolOutcome').mockRejectedValueOnce(new Error('disk unavailable'));
  const gate = new PermissionGate({ getMode: () => 'unrestricted', emit: vi.fn(),
    waitForUserInput: async () => JSON.stringify({ approved: true, recoveryReviewed: true, recoveryFingerprint: snapshot.fingerprint }) });
  expect(await gate.check({ toolUseId: 'new', toolName: tool.name, tool, input, outcomeRecovery: recovery.state })).toMatchObject({ allowed: false });
  expect(recovery.state.toolUseIds).toEqual(['old']);
});

it('automatically resolves a terminal receipt bound to the exact run, tool and arguments', async () => {
  await unknown(); const recovery = await controller();
  await recovery.observe(receipt(), 'original-run');
  expect(recovery.state.toolUseIds).toEqual([]);
  expect((await store.getToolOutcomeState(session.id)).resolved[0].kind).toBe('verified_terminal');
});

it('does not accept a receipt from another run, arguments or tool', async () => {
  await unknown(); const recovery = await controller();
  await recovery.observe(receipt(), 'other-run');
  await recovery.observe(receipt({ inputHash: toolOutcomeInputHash({ path: 'other.ts' }) }), 'original-run');
  await recovery.observe(receipt({ toolName: 'write_file' }), 'original-run');
  expect(recovery.state.toolUseIds).toEqual(['old']);
});

it('handles a terminal receipt arriving before the uncertain turn is committed', async () => {
  const recovery = await controller(); await recovery.observe(receipt({ outcome: 'not_applied' }), 'original-run');
  await unknown(); await recovery.historyCommitted();
  expect(recovery.state.toolUseIds).toEqual([]);
  expect((await store.getToolOutcomeState(session.id)).resolved[0].kind).toBe('verified_not_applied');
});

it('does not clear incidents created after the displayed review snapshot', async () => {
  await unknown(); const recovery = await controller(); const snapshot = recovery.state.snapshot!();
  await unknown('new-unknown');
  await expect(snapshot.acknowledge!()).rejects.toThrow('changed');
  expect((await store.getToolOutcomeState(session.id)).unresolvedToolUseIds.sort()).toEqual(['new-unknown', 'old']);
});

it('accepts a review racing an already verified terminal receipt without re-opening recovery', async () => {
  await unknown(); const recovery = await controller(); const snapshot = recovery.state.snapshot!();
  await recovery.observe(receipt(), 'original-run'); await snapshot.acknowledge!();
  expect(recovery.state.toolUseIds).toEqual([]);
  expect((await store.getToolOutcomeState(session.id)).resolved).toHaveLength(1);
});

it('ordinary receipts do not rescan history or create journal writes', async () => {
  const recovery = await controller();
  const read = vi.spyOn(store, 'getToolOutcomeState'); const resolve = vi.spyOn(store, 'resolveToolOutcome');
  for (let i = 0; i < 1200; i++) await recovery.observe(receipt({ toolUseId: `normal-${i}` }), 'original-run');
  await recovery.state.refresh!();
  expect(read).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
});

it('a recovery review cannot turn alwaysAllow into a persistent database grant', async () => {
  await unknown(); const recovery = await controller(); const snapshot = recovery.state.snapshot!();
  const grant = vi.fn(); let asks = 0;
  const gate = new PermissionGate({ getMode: () => 'auto', emit: vi.fn(), onGrant: grant,
    waitForUserInput: async () => JSON.stringify(++asks === 1
      ? { approved: true, recoveryReviewed: true, recoveryFingerprint: snapshot.fingerprint, alwaysAllow: true }
      : { approved: false }) });
  const request = { toolUseId: 'new', toolName: 'db_query', tool: { ...tool, name: 'db_query' }, input: { sql: 'DELETE FROM fixture' }, outcomeRecovery: recovery.state };
  expect(await gate.check(request)).toEqual({ allowed: true });
  expect(grant).not.toHaveBeenCalled();
  expect(await gate.check({ ...request, toolUseId: 'next' })).toMatchObject({ allowed: false });
  expect(asks).toBe(2);
});

it('does not acknowledge an unseen occurrence introduced between two review commits', async () => {
  await unknown('a'); await unknown('b'); const recovery = await controller();
  const snapshot = recovery.state.snapshot!(); const original = store.resolveToolOutcome.bind(store);
  vi.spyOn(store, 'resolveToolOutcome').mockImplementationOnce(async value => {
    const result = await original(value);
    await store.recordToolOutcomeIncident({ sessionId: session.id, operationId: 'new-child-observation',
      toolUseId: 'b', toolName: tool.name, args: input, runId: 'new-run', sourceReference: 'child/new-run/b' });
    return { ...result, state: await store.getToolOutcomeState(session.id) };
  });
  await expect(snapshot.acknowledge!()).rejects.toThrow('changed');
  const pending = (await store.getToolOutcomeState(session.id)).pending;
  expect(pending.filter(row => row.toolUseId === 'b')).toHaveLength(2);
});

it('automatically releases an already waiting auto-mode approval when a terminal receipt arrives', async () => {
  await unknown(); const recovery = await controller();
  let resolve!: (answer: string) => void; let slotOpen = false;
  const emit = vi.fn();
  const gate = new PermissionGate({ getMode: () => 'auto', emit,
    waitForUserInput: () => { slotOpen = true; return new Promise(done => { resolve = done; }); },
    resolvePending: (_id, answer) => { if (!slotOpen) return false; slotOpen = false; resolve(answer); return true; },
  });
  const result = gate.check({ toolUseId: 'new', toolName: tool.name, tool, input: { ...input, path: 'different.ts' }, outcomeRecovery: recovery.state });
  await vi.waitFor(() => expect(slotOpen).toBe(true));
  await recovery.observe(receipt(), 'original-run');
  expect(await result).toEqual({ allowed: true });
  expect(gate.pendingCount()).toBe(0);
  expect(emit).toHaveBeenCalledWith('tool_approval_resolved', expect.objectContaining({ source: 'recovery' }));
});

it('imports supplemental typed history durably and does not resurrect it after review', async () => {
  const recovery = await controller();
  const history = [
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'imported', name: tool.name, input }] },
    { role: 'tool' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'imported', content: 'unknown', effect_outcome: 'unknown' as const }] },
  ];
  const { ctx } = makeTestContext({ toolContext: { cwd: root, projectName: 'fixture', sessionId: session.id, outcomeRecovery: recovery.state } });
  ctx.opts.initialMessages = history;
  await new BootstrapNode().execute(ctx, null);
  expect(recovery.state.toolUseIds).toEqual(['imported']);
  await recovery.state.snapshot!().acknowledge!();
  await new BootstrapNode().execute(ctx, null);
  expect(recovery.state.toolUseIds).toEqual([]);
  expect((await store.getToolOutcomeState(session.id)).incidents).toHaveLength(1);
});
