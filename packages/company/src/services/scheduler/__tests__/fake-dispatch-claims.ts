import type { DispatchCardKanban } from '../dispatch-card.js';
/** Unit-test adapter only. Concurrency/fencing use real immutable file CAS in
 * dispatch-multisession.test.ts. */
export function fakeDispatchClaims(agentRunId: string): DispatchCardKanban['dispatchClaims'] {
  return {
    acquire: async (_cardId, sessionId) => ({ token: 'unit', epoch: 1, sessionId, agentRunId, phase: 'reserved', leaseUntil: Date.now() + 60_000 }),
    transition: async (_cardId, claim, phase) => ({ ...claim, phase }),
    read: async () => null,
  };
}
