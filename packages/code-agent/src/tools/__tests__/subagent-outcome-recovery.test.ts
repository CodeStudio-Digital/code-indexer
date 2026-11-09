import { expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../core/messages.js';
import type { OutcomeRecoveryState } from '../../core/outcome-recovery-state.js';
import type { ToolOutcomeTerminalReceipt } from '../../core/tool-outcome-observer.js';
import { createSubagentOutcomeRecovery } from '../subagent-outcome-recovery.js';
import { runSubagent } from '../implement-subagent.js';

const history: AgentMessage[] = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'edit_file', input: { path: 'file.ts' } }] },
  { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'lost response', effect_outcome: 'unknown', is_error: true }] },
];

function parentFixture() {
  const pending = new Set<string>();
  const resolved = new Set<string>();
  const register = vi.fn(async (input: Parameters<NonNullable<OutcomeRecoveryState['registerIncident']>>[0]) => {
    pending.add(input.toolUseId); resolved.delete(input.toolUseId);
  });
  const acknowledge = vi.fn(async () => { for (const id of pending) resolved.add(id); pending.clear(); });
  const state: OutcomeRecoveryState = {
    authoritative: true,
    get toolUseIds() { return [...pending]; },
    get resolvedToolUseIds() { return [...resolved]; },
    registerIncident: register,
    snapshot: () => ({ fingerprint: [...pending].sort().join(','),
      incidents: [...pending].map(toolUseId => ({ toolUseId })), acknowledge }),
  };
  const observed = vi.fn();
  const child = (sourceReference = 'child-A', initialMessages = history) => createSubagentOutcomeRecovery({
    parent: state, onTerminal: observed, sourceReference, initialMessages, getRunId: () => 'run-child',
  });
  return { state, pending, resolved, register, acknowledge, observed, child };
}

it('imports only typed unknown history and keeps reviewed aliases live on resume', async () => {
  const f = parentFixture();
  const child = await f.child();
  const id = child.qualify('call-1');
  expect(f.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    toolUseId: id, toolName: 'edit_file', args: { path: 'file.ts' },
  }));
  expect(f.register.mock.calls[0][0].runId).toBeUndefined();
  expect(child.state.toolUseIds).toContain('call-1');
  await child.state.snapshot!().acknowledge!();
  expect(child.state.toolUseIds).toEqual([]);
  expect(child.state.resolvedToolUseIds).toContain('call-1');
  const resumed = await f.child();
  expect(f.register).toHaveBeenCalledOnce();
  expect(resumed.state.resolvedToolUseIds).toContain('call-1');
});

it('isolates equal provider IDs in sibling histories', async () => {
  const f = parentFixture();
  const a = await f.child('child-A');
  const b = await f.child('child-B');
  expect(a.qualify('call-1')).not.toBe(b.qualify('call-1'));
  f.pending.delete(a.qualify('call-1')); f.resolved.add(a.qualify('call-1'));
  expect(a.state.resolvedToolUseIds).toContain('call-1');
  expect(b.state.resolvedToolUseIds).not.toContain('call-1');
  expect(b.state.toolUseIds).toContain('call-1');
});

it('does not resolve a child from an unrelated resolved raw ID in the parent', async () => {
  const f = parentFixture();
  f.resolved.add('call-1');
  const child = await f.child();
  expect(child.state.toolUseIds).toContain('call-1');
  expect(child.state.resolvedToolUseIds).not.toContain('call-1');
});

it('registers a new run occurrence even when an old occurrence using the same ID was reviewed', async () => {
  const f = parentFixture();
  const child = await f.child();
  await child.state.snapshot!().acknowledge!();
  child.recordUnknown({ toolUseId: 'call-1', toolName: 'edit_file', args: { path: 'new.ts' }, runId: 'new-run' });
  await child.drain();
  expect(f.register).toHaveBeenCalledTimes(2);
  expect(f.register.mock.lastCall?.[0]).toMatchObject({ runId: 'new-run', args: { path: 'new.ts' } });
  expect(child.state.resolvedToolUseIds).not.toContain('call-1');
});

it('forwards exact namespaced terminal evidence with child run identity once', async () => {
  const f = parentFixture();
  const child = await f.child();
  const receipt: ToolOutcomeTerminalReceipt = { version: 1, toolUseId: 'call-1', toolName: 'edit_file',
    invocationId: 'invocation', inputHash: 'a'.repeat(64), outcome: 'confirmed', completedAt: new Date().toISOString(), source: 'registry' };
  await child.onTerminal(receipt);
  expect(f.observed).toHaveBeenCalledExactlyOnceWith({ ...receipt, toolUseId: child.qualify('call-1') }, 'run-child');
  const descendant = { ...receipt, toolUseId: 'already-namespaced-grandchild' };
  await child.onTerminal(descendant, 'grandchild-run');
  expect(f.observed.mock.lastCall).toEqual([descendant, 'grandchild-run']);
});

it('does not infer unknown effects from text or expose review for undurable incidents', async () => {
  const f = parentFixture();
  await f.child('text-only', [{ role: 'assistant', content: [{ type: 'text', text: 'TOOL_OUTCOME_UNKNOWN: call-1' }] }]);
  expect(f.register).not.toHaveBeenCalled();
  const child = await createSubagentOutcomeRecovery({ parent: { toolUseIds: [] }, onTerminal: undefined,
    sourceReference: 'adhoc', initialMessages: history, getRunId: () => undefined });
  expect(child.state.toolUseIds).toContain('call-1');
  expect(child.state.snapshot!().incidents).toHaveLength(1);
  expect(child.state.snapshot!().acknowledge).toBeUndefined();
});

it('fails closed at the child terminal boundary when durable registration fails', async () => {
  const child = await createSubagentOutcomeRecovery({ parent: { toolUseIds: [],
    registerIncident: async () => { throw new Error('disk unavailable'); } }, onTerminal: undefined,
    sourceReference: 'child', initialMessages: [], getRunId: () => 'child-run' });
  child.recordUnknown({ toolUseId: 'call-1', toolName: 'edit_file', args: {}, runId: 'child-run' });
  await expect(child.drain()).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
  expect(child.state.snapshot!().acknowledge).toBeUndefined();
});

it('registers child history before the real subagent Bootstrap/provider call', async () => {
  const f = parentFixture();
  let called = false;
  const result = await runSubagent({ tools: [], ctx: { cwd: process.cwd(), projectName: 'fixture', outcomeRecovery: f.state },
    provider: { name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
      called = true;
      expect(f.register).toHaveBeenCalledOnce();
      expect(request.system).toContain('<tool-outcome-recovery>');
      expect(request.system).toContain('call-1');
      yield { type: 'text_delta' as const, text: 'Inspection only.' };
      yield { type: 'done' as const, stop_reason: 'end_turn' };
    } },
  }, { systemPrompt: 'Inspect only', initialMessages: history, maxTurns: 1, allowlist: null,
    label: 'fixture child', chatKey: 'stable-child', profile: 'explore' });
  expect(called).toBe(true);
  expect(result.reason).not.toBe('error');
});
