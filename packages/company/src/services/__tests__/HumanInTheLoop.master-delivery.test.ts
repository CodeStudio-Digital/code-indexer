import { describe, expect, it, vi } from 'vitest';
import { HumanInTheLoop } from '../HumanInTheLoop.js';
import type { MasterPrompt } from '@mcp/company/types.js';

function prompt(kind: 'plan' | 'question'): MasterPrompt {
  return {
    id: kind === 'plan' ? 71 : 72,
    company_session_id: 1,
    agent_run_id: 9,
    kind,
    runner_block_id: null,
    body: kind === 'plan' ? 'ship it' : 'why?',
    options: null,
    allow_freeform: true,
    status: 'pending',
    answer: null,
    approved: null,
    feedback: null,
    created_at: '2026-01-01T00:00:00.000Z',
    resolved_at: null,
  };
}

function makeHarness(kind: 'plan' | 'question', delivered: boolean) {
  const pending = prompt(kind);
  const order: string[] = [];
  const provideUserInput = vi.fn(() => {
    order.push('deliver');
    return delivered;
  });
  const claimMasterPromptDelivery = vi.fn(() => {
    order.push('claim');
    return { kind: 'claimed' as const, prompt: pending, token: 'store-token' };
  });
  const releaseMasterPromptDelivery = vi.fn(() => {
    order.push('release');
    return true;
  });
  const completeMasterPromptDelivery = vi.fn<() => MasterPrompt | null>(() => {
    order.push('complete');
    return { ...pending, status: 'answered' };
  });
  const markMasterPromptDeliveryOutcomeUnknown = vi.fn(() => {
    order.push('unknown');
    return true;
  });
  const companyStore = {
    getPendingMasterPrompt: vi.fn(() => pending),
    claimMasterPromptDelivery,
    releaseMasterPromptDelivery,
    completeMasterPromptDelivery,
    markMasterPromptDeliveryOutcomeUnknown,
  };
  const bus = { publish: vi.fn(), markEnded: vi.fn(), bus: {} };
  const board = { post: vi.fn() };
  const status = { setStatus: vi.fn(), publishStatus: vi.fn() };
  const master = {
    handle: { runner: { provideUserInput } },
    agentRunId: 9,
    setShouldContinue: vi.fn(),
    notify: vi.fn(),
  };
  const attention = { signal: vi.fn(), on: () => () => {} };
  const ctx = { companySessionId: 1, companyStore };
  const hitl = new HumanInTheLoop(
    bus as never,
    board as never,
    status as never,
    master as never,
    attention as never,
    ctx as never,
  );

  return {
    hitl,
    pending,
    order,
    provideUserInput,
    claimMasterPromptDelivery,
    releaseMasterPromptDelivery,
    completeMasterPromptDelivery,
    markMasterPromptDeliveryOutcomeUnknown,
    bus,
    board,
  };
}

describe('HumanInTheLoop master prompt delivery authority', () => {
  it.each(['plan', 'question'] as const)(
    'leaves a refused %s response pending and never reports success',
    (kind) => {
      const h = makeHarness(kind, false);

      const result = kind === 'plan'
        ? h.hitl.respondToMasterPlan(true, undefined, h.pending.id)
        : h.hitl.respondToMasterQuestion('because', h.pending.id);

      expect(result).toBeNull();
      expect(h.order).toEqual(['claim', 'deliver', 'release']);
      expect(h.completeMasterPromptDelivery).not.toHaveBeenCalled();
      expect(h.markMasterPromptDeliveryOutcomeUnknown).not.toHaveBeenCalled();
      expect(h.bus.publish).not.toHaveBeenCalled();
      expect(h.board.post).not.toHaveBeenCalled();
    },
  );

  it.each(['plan', 'question'] as const)(
    'persists a successful %s response only after runner acknowledgement',
    (kind) => {
      const h = makeHarness(kind, true);

      const result = kind === 'plan'
        ? h.hitl.respondToMasterPlan(true, undefined, h.pending.id)
        : h.hitl.respondToMasterQuestion('because', h.pending.id);

      expect(result).toMatchObject({ status: 'answered' });
      expect(h.order).toEqual(['claim', 'deliver', 'complete']);
      expect(h.bus.publish).toHaveBeenCalledTimes(1);
      expect(h.board.post).toHaveBeenCalledTimes(1);
    },
  );

  it('fences a delivered response whose durable completion cannot be confirmed', () => {
    const h = makeHarness('question', true);
    h.completeMasterPromptDelivery.mockImplementationOnce(() => {
      h.order.push('complete');
      return null;
    });

    expect(() => h.hitl.respondToMasterQuestion('because', h.pending.id))
      .toThrowError(expect.objectContaining({ code: 'OUTCOME_UNKNOWN' }));
    expect(h.order).toEqual(['claim', 'deliver', 'complete', 'unknown']);
    expect(h.bus.publish).not.toHaveBeenCalled();
  });
});
