import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { createSessionOutcomeRecovery } from '../../sessions/outcome-recovery.js';
import { createSubagentOutcomeRecovery } from '../../tools/subagent-outcome-recovery.js';
import { PermissionGate, type ToolPermissionMode } from '../permission-gate.js';
import type { OutcomeRecoveryState } from '../outcome-recovery-state.js';
import type { CoderTool, ToolContext } from '../tool.js';
import { ToolRegistry } from '../registry.js';
import { ToolCallLedger } from '../tool-call-ledger.js';
import { CoderRunner } from '../runner.js';
import { needsOutcomeRecoveryApproval, outcomeRecoveryPrompt, uncertainToolOutcomeError } from '../uncertain-tool-outcome.js';
import { permissionsSection } from '../permissions-prompt.js';
import { buildCodeExecTool } from '../../tools/code-exec.js';

const oldInput = { code: 'return await tools.run_command({command:"old command"});' };
const edit: CoderTool = { name: 'edit_file', source: 'native', description: 'fixture',
  mutates: true, riskLevel: 'write', parameters: { type: 'object', properties: {} },
  handler: async () => ({ content: 'synthetic edit' }) };
const command: CoderTool = { ...edit, name: 'run_command', riskLevel: 'execute', effectBoundary: 'shell' };
const oldWrapper: CoderTool = { ...edit, name: 'code_exec', effectBoundary: 'nested' };
function hostState(): OutcomeRecoveryState {
  return { authoritative: true, toolUseIds: ['legacy-call'],
    replayToolUseIds: (name, input) => name === 'code_exec' && JSON.stringify(input) === JSON.stringify(oldInput) ? ['legacy-call'] : [],
    snapshot: () => ({ fingerprint: 'occurrence-1', incidents: [{ toolUseId: 'legacy-call', toolName: 'code_exec' }] }) };
}
function setup(mode: ToolPermissionMode = 'unrestricted', recovery = hostState()) {
  const wait = vi.fn(async () => JSON.stringify({ approved: false })), emit = vi.fn();
  const gate = new PermissionGate({ getMode: () => mode, waitForUserInput: wait, emit });
  const registry = new ToolRegistry(), handler = vi.fn(edit.handler);
  registry.register({ ...edit, handler }); registry.register(command);
  const context: ToolContext = { cwd: process.cwd(), projectName: 'fixture', currentToolUseId: 'new',
    outcomeRecovery: recovery, permissionGate: gate, toolCallLedger: new ToolCallLedger() };
  const request = (tool: CoderTool, input: Record<string, unknown> = { path: 'new.ts' }) =>
    ({ toolUseId: 'new', toolName: tool.name, tool, input, outcomeRecovery: recovery });
  return { wait, emit, gate, registry, handler, context, request };
}

describe('unrestricted permission remains effective during historical recovery', () => {
  it.each([edit, command, { ...edit, name: 'external_update', source: 'mcp_external' as const }])(
    'does not ask for a new $name invocation or erase old evidence', async tool => {
      const h = setup(); if (!h.registry.has(tool.name)) h.registry.register(tool);
      expect(await h.gate.check(h.request(tool))).toEqual({ allowed: true });
      expect((await h.registry.invoke(tool.name, { path: 'new.ts' }, h.context)).isError).toBeFalsy();
      expect(h.wait).not.toHaveBeenCalled(); expect(h.emit).not.toHaveBeenCalled();
      expect(h.context.outcomeRecovery!.toolUseIds).toEqual(['legacy-call']);
    });

  it('allows nested new edits under the same explicit mode', async () => {
    const h = setup(), wrapper = buildCodeExecTool(h.registry);
    expect((await wrapper.handler({ code: 'return await tools.edit_file({path:"new.ts"});' }, h.context)).isError).toBeFalsy();
    expect(h.handler).toHaveBeenCalledOnce(); expect(h.wait).not.toHaveBeenCalled();
  });

  it.each(['ask', 'auto'] as const)('retains explicit recovery approval in %s mode', async mode => {
    const h = setup(mode);
    expect(await h.gate.check(h.request(edit))).toMatchObject({ allowed: false });
    expect((await h.registry.invoke(edit.name, { path: 'new.ts' }, h.context)).isError).toBe(true);
    expect(h.handler).not.toHaveBeenCalled(); expect(h.wait).toHaveBeenCalledOnce();
  });

  it('still gates the exact uncertain script and database writes separately', async () => {
    const h = setup();
    expect(await h.gate.check(h.request(oldWrapper, oldInput))).toMatchObject({ allowed: false });
    const db = { ...edit, name: 'db_query' };
    expect(await h.gate.check(h.request(db, { sql: 'DELETE FROM fixture' }))).toMatchObject({ allowed: false });
    expect(h.emit).toHaveBeenCalledWith('tool_approval_request', expect.objectContaining({ approvalKind: 'database_write' }));
    expect(h.wait).toHaveBeenCalledTimes(2);
  });

  it('does not treat missing host signature evidence or a missing gate as unrestricted consent', async () => {
    for (const recovery of [{ toolUseIds: ['old'] }, { authoritative: true, toolUseIds: ['old'] }]) {
      const h = setup('unrestricted', recovery);
      expect(await h.gate.check(h.request(edit))).toMatchObject({ allowed: false });
    }
    const h = setup(); delete h.context.permissionGate;
    expect((await h.registry.invoke(edit.name, { path: 'new.ts' }, h.context)).isError).toBe(true);
    expect(h.handler).not.toHaveBeenCalled();
  });

  it('keeps the same-attempt unknown guard even with unrestricted permission', async () => {
    const h = setup(); h.context.toolCallLedger!.markOutcomeUnknown('earlier-current-attempt');
    expect((await h.registry.invoke(edit.name, { path: 'new.ts' }, h.context)).effectOutcome).toBe('unknown');
    expect(h.handler).not.toHaveBeenCalled();
  });

  it('uses the live mode switch to release a waiting new call without recording a human review', async () => {
    const h = setup('ask');
    const runner = new CoderRunner({ provider: { name: 'fixture', model: 'fixture', setModel() {}, async *chat() { yield { type: 'done' as const }; } },
      registry: h.registry, systemPrompt: 'fixture', toolContext: h.context, toolPermissionMode: 'ask' });
    const slots = new Map<string, (answer: string) => void>(), emit = vi.fn();
    const gate = new PermissionGate({ getMode: () => runner.getToolPermissionMode(), emit,
      waitForUserInput: id => new Promise(resolve => { slots.set(id, resolve); }),
      resolvePending: (id, answer) => { const slot = slots.get(id); if (!slot) return false; slots.delete(id); slot(answer); return true; } });
    h.context.permissionGate = gate;
    const decision = gate.check(h.request(edit)); expect(gate.pendingCount()).toBe(1);
    runner.setToolPermissionMode('unrestricted');
    expect(await decision).toEqual({ allowed: true }); expect(slots.size).toBe(0);
    expect((await h.registry.invoke(edit.name, { path: 'new.ts' }, h.context)).isError).toBeFalsy();
    expect(h.context.outcomeRecovery!.toolUseIds).toEqual(['legacy-call']);
  });

  it('keeps delegated new work free and blocks a child whose evidence was not persisted', async () => {
    const child = await createSubagentOutcomeRecovery({ parent: hostState(), onTerminal: undefined,
      sourceReference: 'child', initialMessages: [], getRunId: () => 'run' });
    expect(needsOutcomeRecoveryApproval(child.state, edit, {}, 'unrestricted')).toBe(false);
    const incomplete = await createSubagentOutcomeRecovery({ parent: hostState(), onTerminal: undefined,
      sourceReference: 'incomplete', getRunId: () => 'run', initialMessages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'child-old', name: edit.name, input: {} }] },
        { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'child-old', content: 'lost', effect_outcome: 'unknown' }] },
      ] });
    expect(needsOutcomeRecoveryApproval(incomplete.state, edit, {}, 'unrestricted')).toBe(true);
  });

  it('aligns static and live prompts with the selected mode', () => {
    expect(permissionsSection({ approvalMode: 'unrestricted', writableRoots: ['fixture'] })).toContain('do not revoke unrestricted permission');
    expect(outcomeRecoveryPrompt(hostState(), 'unrestricted')).toContain('Continue new authorized work without asking');
    expect(outcomeRecoveryPrompt(hostState(), 'auto')).toContain('require explicit recovery approval');
    expect(uncertainToolOutcomeError('old').message).toContain('follow the selected permission mode for new work');
    expect(uncertainToolOutcomeError('old').message).not.toContain('new effects require explicit approval');
  });

  it('persists unrestricted mode across reload without acknowledging the old code_exec incident', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unrestricted-recovery-'));
    const project = join(root, 'project'); await mkdir(project);
    const store = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
      resolveProjectRoot: () => project, listProjectRoots: () => [{ project_id: 7, root_path: project }],
    } });
    try {
      const session = await store.createSession({ project_id: 7, title: 'fixture', provider: 'test', model: 'test' });
      await store.setSessionToolPermissionMode(session.id, 'unrestricted');
      await store.persistAssistantTurn({ session_id: session.id, operation_id: 'legacy-fixture', usage: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'legacy-call', name: 'code_exec', input: oldInput }] },
        tool_calls: [{ tool_use_id: 'legacy-call', tool_name: 'code_exec', args: oldInput, result_text: 'lost acknowledgement', effect_outcome: 'unknown', is_error: true, duration_ms: 1 }],
      });
      for (let restart = 0; restart < 2; restart++) {
        const saved = await store.loadSessionWithMessages(session.id);
        expect(saved!.session.tool_permission_mode).toBe('unrestricted');
        const recovery = await createSessionOutcomeRecovery({ store, sessionId: session.id });
        const h = setup('unrestricted', recovery.state);
        expect(await h.gate.check(h.request(edit))).toEqual({ allowed: true });
        expect((await h.registry.invoke(edit.name, { path: 'new.ts' }, h.context)).isError).toBeFalsy();
        expect(h.wait).not.toHaveBeenCalled();
        expect(await h.gate.check(h.request(oldWrapper, oldInput))).toMatchObject({ allowed: false });
        expect(recovery.state.toolUseIds).toEqual(['legacy-call']);
        expect((await store.getToolOutcomeState(session.id)).resolved).toEqual([]);
      }
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
