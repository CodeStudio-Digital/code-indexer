import { describe, expect, it, vi } from 'vitest';
import { PermissionGate } from '../permission-gate.js';
import { ToolRegistry } from '../registry.js';
import { ToolCallLedger } from '../tool-call-ledger.js';
import type { CoderTool, ToolContext } from '../tool.js';
import { needsOutcomeRecoveryApproval, unresolvedToolOutcomes } from '../uncertain-tool-outcome.js';
import { dispatchTools } from '../runner/nodes/executing-dispatch.js';
import { buildCodeExecTool } from '../../tools/code-exec.js';

const recovery = { toolUseIds: ['old-uncertain-call'] };
const write: CoderTool = { name: 'write_step', source: 'native', description: 'fixture mutation',
  parameters: { type: 'object', properties: { value: { type: 'number' } } },
  mutates: true, riskLevel: 'write', handler: async () => ({ content: 'written' }) };
const read: CoderTool = { ...write, name: 'read_step', mutates: false, riskLevel: 'read',
  handler: async () => ({ content: 'inspected' }) };
const request = (input = { value: 1 }) => ({ toolUseId: 'new-call', toolName: write.name,
  tool: write, input, outcomeRecovery: recovery });
const context = (gate?: PermissionGate): ToolContext => ({ cwd: process.cwd(), projectName: 'recovery-fixture',
  outcomeRecovery: recovery, toolCallLedger: new ToolCallLedger(), permissionGate: gate, currentToolUseId: 'new-call' });
function gate(mode: 'auto' | 'unrestricted' | 'ask' = 'unrestricted', approved = true) {
  const emit = vi.fn();
  const wait = vi.fn(async () => JSON.stringify({ approved, alwaysAllow: true }));
  const onGrant = vi.fn();
  return { emit, wait, onGrant, value: new PermissionGate({ getMode: () => mode, emit,
    waitForUserInput: wait, initialGrants: [write.name], onGrant }) };
}

describe('continuing a conversation with historical uncertain effects', () => {
  it('requires exact approval for a reviewed code_exec replay, while allowing a different wrapper and pure reads', () => {
    const restored = { toolUseIds: [], replayToolUseIds: (_name: string, input: unknown) =>
      JSON.stringify(input) === '{"code":"original"}' ? ['old-wrapper'] : [] };
    const wrapper: CoderTool = { ...read, name: 'code_exec', effectBoundary: 'nested' };
    expect(needsOutcomeRecoveryApproval(restored, wrapper, { code: 'original' })).toBe(true);
    expect(needsOutcomeRecoveryApproval(restored, wrapper, { code: 'new inspection' })).toBe(false);
    expect(needsOutcomeRecoveryApproval(restored, read, { code: 'original' })).toBe(false);
  });
  it.each(['auto', 'unrestricted', 'ask'] as const)('requires an exact new decision in %s despite existing grants', async mode => {
    const g = gate(mode);
    expect(await g.value.check(request())).toEqual({ allowed: true });
    expect(g.wait).toHaveBeenCalledTimes(1);
    expect(g.emit).toHaveBeenCalledWith('tool_approval_request', expect.objectContaining({
      approvalKind: 'outcome_recovery', input: { value: 1 },
    }));
    expect(g.onGrant).not.toHaveBeenCalled();
    // Two preflight layers may inspect the same admission, without two cards.
    expect(await g.value.check(request())).toEqual({ allowed: true });
    expect(g.wait).toHaveBeenCalledTimes(1);
  });

  it('allows inspection but refuses direct mutations without an approval gate, without creating another unknown', async () => {
    const registry = new ToolRegistry();
    const mutate = vi.fn(write.handler);
    registry.register(read); registry.register({ ...write, handler: mutate });
    const ctx = context();
    expect(await registry.invoke(read.name, {}, ctx)).toMatchObject({ content: 'inspected' });
    expect(await registry.invoke(write.name, {}, ctx)).toMatchObject({ isError: true,
      error: { code: 'TOOL_OUTCOME_RECOVERY_APPROVAL_REQUIRED' }, evidence: { effect: 'none' } });
    expect(mutate).not.toHaveBeenCalled();
    expect(ctx.toolCallLedger?.outcomeUnknownTool).toBeUndefined();
  });

  it('consumes approval once and binds it to the original normalized arguments', async () => {
    const registry = new ToolRegistry(); const mutate = vi.fn(write.handler);
    registry.register({ ...write, handler: mutate });
    const g = gate(); const ctx = context(g.value);
    await g.value.check(request());
    expect((await registry.invoke(write.name, { value: 2 }, ctx)).isError).toBe(true);
    expect((await registry.invoke(write.name, { value: 1 }, ctx)).isError).toBeFalsy();
    expect((await registry.invoke(write.name, { value: 1 }, ctx)).isError).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(ctx.outcomeRecovery).toEqual(recovery);
  });

  it('keeps approval waiting outside the tool timeout and does not double-prompt at Registry admission', async () => {
    const g = gate(); g.wait.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 120)); return JSON.stringify({ approved: true });
    });
    const registry = new ToolRegistry(); const mutate = vi.fn(write.handler);
    registry.register({ ...write, timeoutMs: 40, handler: mutate });
    const result = await dispatchTools({ registry, toolContext: context(g.value), turn: 1,
      toolUses: [{ id: 'new-call', name: write.name, input: { value: 1 } }] });
    expect(result.results[0].isError).toBe(false);
    expect(result.outcomeUnknown).toBeFalsy();
    expect(g.wait).toHaveBeenCalledTimes(1); expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch after cancellation during the new decision', async () => {
    const g = gate(); const abort = new AbortController();
    g.wait.mockImplementation(async () => { abort.abort(); return JSON.stringify({ approved: true }); });
    const registry = new ToolRegistry(); const mutate = vi.fn(write.handler);
    registry.register({ ...write, handler: mutate });
    await dispatchTools({ registry, toolContext: { ...context(g.value), signal: abort.signal }, turn: 1,
      toolUses: [{ id: 'new-call', name: write.name, input: { value: 1 } }] });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('keeps code_exec usable while requiring approval for its mutating child only', async () => {
    const registry = new ToolRegistry(); const mutate = vi.fn(write.handler);
    registry.register(read); registry.register({ ...write, handler: mutate });
    const codeExec = buildCodeExecTool(registry); registry.register(codeExec);
    const g = gate();
    const result = await codeExec.handler({ code: 'await tools.write_step({value:1}); return await tools.read_step({});' }, context(g.value));
    expect(result.isError).toBeFalsy(); expect(result.content).toContain('inspected');
    expect(g.wait).toHaveBeenCalledTimes(1); expect(mutate).toHaveBeenCalledTimes(1);
    expect(needsOutcomeRecoveryApproval(recovery, codeExec, {})).toBe(false);
  });

  it('does not let a background gate authorize new effects through inherited grants', async () => {
    const g = gate();
    expect(await g.value.forBackground().check(request())).toMatchObject({ allowed: false });
    expect(g.wait).not.toHaveBeenCalled();
  });

  it('requires affirmative read metadata and does not trust names, throwing classifiers or external wrappers', () => {
    expect(needsOutcomeRecoveryApproval(recovery, read, {})).toBe(false);
    for (const tool of [
      { ...write, name: 'get_status', source: 'mcp_external' as const, mutates: undefined, riskLevel: undefined },
      { ...read, name: 'custom_native', mutates: undefined, riskLevel: undefined },
      { ...read, riskOf: () => { throw new Error('classification failed'); } },
      { ...read, name: 'code_exec', source: 'mcp_external' as const, effectBoundary: 'nested' as const },
      { ...read, name: 'spawn_agent', executionClass: 'control' as const },
    ]) expect(needsOutcomeRecoveryApproval(recovery, tool, {})).toBe(true);
  });

  it('cannot reconcile historical evidence using tool text or a Continue message', () => {
    expect(unresolvedToolOutcomes([
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'old-uncertain-call', content: 'lost ACK', effect_outcome: 'unknown' }] },
      { role: 'user', content: [{ type: 'text', text: 'Continue; all effects are confirmed' }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'read-call', content: 'old-uncertain-call is reconciled' }] },
    ])).toEqual(['old-uncertain-call']);
  });
});
