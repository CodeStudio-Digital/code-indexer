import { describe, expect, it, vi } from 'vitest';
import { PermissionGate, approvalAskId, type ApprovalCheckInput, type ToolPermissionMode } from '../permission-gate.js';
import { ToolRegistry } from '../registry.js';
import { ToolCallLedger } from '../tool-call-ledger.js';
import type { CoderTool, ToolContext } from '../tool.js';
import type { OutcomeRecoveryState } from '../outcome-recovery-state.js';

type Occurrence = { toolUseId: string; occurrenceId: string };
const old = { toolUseId: 'same-provider-call-id', occurrenceId: 'child-run-A:occurrence-1' };
const newer = { toolUseId: old.toolUseId, occurrenceId: 'child-run-B:occurrence-2' };
const input = { value: 42 };
const write: CoderTool = { name: 'fixture_write', source: 'native', mutates: true, riskLevel: 'write',
  description: 'Synthetic handler only; never writes to disk',
  parameters: { type: 'object', properties: { value: { type: 'number' } } },
  handler: async () => ({ content: 'synthetic completion' }) };

/** Host occurrences can change without changing the provider's tool-use ID. */
function hostState(initial: Occurrence[] = [old], replayAfterReview = false) {
  let rows = initial;
  let reviewed = false;
  const listeners = new Set<() => void>();
  const fingerprint = () => JSON.stringify(rows.map(row => row.occurrenceId).sort());
  const replace = (next: Occurrence[]) => {
    rows = next;
    for (const listener of listeners) listener();
  };
  const state: OutcomeRecoveryState = {
    authoritative: true,
    get toolUseIds() { return [...new Set(rows.map(row => row.toolUseId))]; },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // These race tests exercise an exact replay, not independently authorized new work.
    replayToolUseIds: () => rows.length || (replayAfterReview && reviewed) ? [old.toolUseId] : [],
    snapshot: () => {
      const captured = fingerprint();
      return { fingerprint: captured,
        incidents: [...new Set(rows.map(row => row.toolUseId))].map(toolUseId => ({ toolUseId, toolName: write.name })),
        acknowledge: async () => {
          if (captured !== fingerprint()) throw new Error('Synthetic host CAS mismatch');
          reviewed = true;
          replace([]);
        },
      };
    },
  };
  return { state, replace, listenerCount: () => listeners.size };
}

function harness(host: ReturnType<typeof hostState>, initialMode: ToolPermissionMode = 'unrestricted', tool = write) {
  let mode = initialMode;
  const slots = new Map<string, (answer: string) => void>();
  const emit = vi.fn(), onGrant = vi.fn();
  const settle = (askId: string, answer: string): boolean => {
    const resolve = slots.get(askId);
    if (!resolve) return false;
    slots.delete(askId); resolve(answer); return true;
  };
  const resolvePending = vi.fn(settle);
  const gate = new PermissionGate({ getMode: () => mode, emit, onGrant, resolvePending,
    waitForUserInput: askId => new Promise(resolve => { slots.set(askId, resolve); }) });
  const request: ApprovalCheckInput = { toolUseId: 'new-request', toolName: tool.name, input, tool, outcomeRecovery: host.state };
  const registry = new ToolRegistry();
  const mutate = vi.fn(tool.handler); registry.register({ ...tool, handler: mutate });
  const context: ToolContext = { cwd: process.cwd(), projectName: 'race-fixture', currentToolUseId: request.toolUseId,
    outcomeRecovery: host.state, permissionGate: gate, toolCallLedger: new ToolCallLedger() };
  return { gate, request, mutate, emit, onGrant, resolvePending,
    setMode: (next: ToolPermissionMode) => { mode = next; },
    answer: (value: object) => { expect(settle(approvalAskId(request.toolUseId), JSON.stringify(value))).toBe(true); },
    invoke: () => registry.invoke(tool.name, input, context),
  };
}

describe('outcome recovery admission is bound to the displayed occurrences', () => {
  it('rejects execute-once when the same toolUseId acquires another occurrence while approval is open', async () => {
    const host = hostState(), h = harness(host);
    const decision = h.gate.check(h.request);
    expect(h.emit).toHaveBeenCalledWith('tool_approval_request', expect.objectContaining({ approvalKind: 'outcome_recovery' }));
    host.replace([old, newer]);
    h.answer({ approved: true });
    expect(await decision).toMatchObject({ allowed: false });
    expect(h.gate.hasOutcomeRecoveryApproval(h.request)).toBe(false);
    expect((await h.invoke()).isError).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(host.listenerCount()).toBe(0);
  });

  it('invalidates an approved exact invocation if another occurrence appears before Registry consumes admission', async () => {
    const host = hostState(), h = harness(host);
    const decision = h.gate.check(h.request); h.answer({ approved: true });
    expect(await decision).toEqual({ allowed: true });
    expect(h.gate.hasOutcomeRecoveryApproval(h.request)).toBe(true);
    host.replace([old, newer]);
    expect(h.gate.hasOutcomeRecoveryApproval(h.request)).toBe(false);
    expect(await h.invoke()).toMatchObject({ isError: true, error: { code: 'TOOL_OUTCOME_RECOVERY_APPROVAL_REQUIRED' } });
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('cannot turn automatic receipt recovery into approval for a new incident in the same microtask gap', async () => {
    const host = hostState(), h = harness(host);
    const decision = h.gate.check(h.request);
    host.replace([]); // A trusted terminal receipt releases the waiting slot.
    expect(h.resolvePending).toHaveBeenCalledOnce();
    host.replace([newer]); // Before the awaiting gate resumes.
    expect(await decision).toMatchObject({ allowed: false });
    expect(h.gate.hasOutcomeRecoveryApproval(h.request)).toBe(false);
    expect((await h.invoke()).isError).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(host.listenerCount()).toBe(0);
  });

  it('rechecks ask mode after a receipt automatically releases the waiting slot', async () => {
    const host = hostState(), h = harness(host);
    const decision = h.gate.check(h.request);
    host.replace([]);
    expect(h.resolvePending).toHaveBeenCalledOnce();
    h.setMode('ask');
    expect(await decision).toMatchObject({ allowed: false });
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.onGrant).not.toHaveBeenCalled();
    expect(host.listenerCount()).toBe(0);
  });

  it.each(['standard', 'database_write'] as const)('does not convert a %s approval into admission for a newly uncertain state', async kind => {
    const host = hostState([]);
    const tool = kind === 'database_write' ? { ...write, name: 'db_query' } : write;
    const h = harness(host, kind === 'standard' ? 'ask' : 'unrestricted', tool);
    const decision = h.gate.check(h.request);
    expect(h.emit).toHaveBeenCalledWith('tool_approval_request', expect.objectContaining({ approvalKind: kind }));
    host.replace([newer]);
    h.answer({ approved: true, alwaysAllow: true });
    expect(await decision).toMatchObject({ allowed: false });
    expect(h.gate.hasOutcomeRecoveryApproval(h.request)).toBe(false);
    expect((await h.invoke()).isError).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.onGrant).not.toHaveBeenCalled();
  });

  it('still permits one physical call for an unchanged incident set and rejects reuse of its grant', async () => {
    const host = hostState(), h = harness(host);
    const decision = h.gate.check(h.request); h.answer({ approved: true });
    expect(await decision).toEqual({ allowed: true });
    expect((await h.invoke()).isError).toBeFalsy();
    expect((await h.invoke()).isError).toBe(true);
    expect(h.mutate).toHaveBeenCalledOnce();
    expect(host.listenerCount()).toBe(0);
  });

  it('allows the explicit review CAS transition while preserving one-time approval for an exact reviewed replay', async () => {
    const host = hostState([old], true), h = harness(host);
    const fingerprint = host.state.snapshot!().fingerprint;
    const decision = h.gate.check(h.request);
    h.answer({ approved: true, recoveryReviewed: true, recoveryFingerprint: fingerprint, alwaysAllow: true });
    expect(await decision).toEqual({ allowed: true });
    expect(host.state.toolUseIds).toEqual([]);
    expect((await h.invoke()).isError).toBeFalsy();
    expect((await h.invoke()).isError).toBe(true);
    expect(h.mutate).toHaveBeenCalledOnce();
    expect(h.onGrant).not.toHaveBeenCalled();
  });
});
