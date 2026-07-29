import { describe, expect, it, vi } from 'vitest';
import { HumanInTheLoop } from '../HumanInTheLoop.js';
import type { MasterPrompt } from '@mcp/company/types.js';

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const MASTER_AGENT_RUN_ID = '00000000-0000-4000-8000-000000000009';

function prompt(kind: 'plan' | 'question'): MasterPrompt {
  return {
    id:
      kind === 'plan'
        ? '00000000-0000-4000-8000-000000000071'
        : '00000000-0000-4000-8000-000000000072',
    company_session_id: COMPANY_SESSION_ID,
    agent_run_id: MASTER_AGENT_RUN_ID,
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
  const claimMasterPromptDelivery = vi.fn(async () => {
    order.push('claim');
    return { kind: 'claimed' as const, prompt: pending, token: 'store-token' };
  });
  const releaseMasterPromptDelivery = vi.fn(async () => {
    order.push('release');
    return true;
  });
  const completeMasterPromptDelivery = vi.fn(async (): Promise<MasterPrompt | null> => {
    order.push('complete');
    return { ...pending, status: 'answered' };
  });
  const markMasterPromptDeliveryOutcomeUnknown = vi.fn(async () => {
    order.push('unknown');
    return true;
  });
  const companyFiles = {
    getPendingMasterPrompt: vi.fn(async () => pending),
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
    agentRunId: MASTER_AGENT_RUN_ID,
    setShouldContinue: vi.fn(),
    notify: vi.fn(),
  };
  const attention = { signal: vi.fn(), on: () => () => {} };
  const ctx = { companySessionId: COMPANY_SESSION_ID, companyFiles };
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
    async (kind) => {
      const h = makeHarness(kind, false);

      const result = await (kind === 'plan'
        ? h.hitl.respondToMasterPlan(true, undefined, h.pending.id)
        : h.hitl.respondToMasterQuestion('because', h.pending.id));

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
    async (kind) => {
      const h = makeHarness(kind, true);

      const result = await (kind === 'plan'
        ? h.hitl.respondToMasterPlan(true, undefined, h.pending.id)
        : h.hitl.respondToMasterQuestion('because', h.pending.id));

      expect(result).toMatchObject({ status: 'answered' });
      expect(h.order).toEqual(['claim', 'deliver', 'complete']);
      expect(h.bus.publish).toHaveBeenCalledTimes(1);
      expect(h.board.post).toHaveBeenCalledTimes(1);
    },
  );

  it('fences a delivered response whose durable completion cannot be confirmed', async () => {
    const h = makeHarness('question', true);
    h.completeMasterPromptDelivery.mockImplementationOnce(async () => {
      h.order.push('complete');
      return null;
    });

    await expect(
      h.hitl.respondToMasterQuestion('because', h.pending.id),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(h.order).toEqual(['claim', 'deliver', 'complete', 'unknown']);
    expect(h.bus.publish).not.toHaveBeenCalled();
  });
});
