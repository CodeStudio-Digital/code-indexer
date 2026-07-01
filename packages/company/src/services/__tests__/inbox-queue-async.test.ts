/**
 * Tests for C9 — Async-friendly InboxQueue accessors.
 *
 * Locks in:
 *   - getMessageStatus returns current row snapshot
 *   - getMessageStatus returns null for unknown id
 *   - onMessageAnswered fires when status flips to answered/expired/cancelled
 *   - onMessageAnswered fires once (one-shot) and auto-cleans listeners
 *   - onMessageAnswered fires synchronously-once when message is ALREADY terminal
 *   - unsubscribe prevents future fires
 */
import { describe, expect, it } from 'vitest';
import { InboxQueue, type InboxQueueDeps } from '../InboxQueue.js';
import type {
  AgentInboxMessage,
  InboxStatus,
} from '@mcp/company-contracts/models/inbox.js';
import type { IMetaBusPublisher } from '../ports.js';

const COMPANY_SESSION_ID = 100;

function makeMessage(over: Partial<AgentInboxMessage> & Pick<AgentInboxMessage, 'id'>): AgentInboxMessage {
  return {
    id: over.id,
    company_session_id: COMPANY_SESSION_ID,
    from_agent_run_id: 99,
    from_role: 'sender',
    to_role: 'qa',
    to_agent_run_id: 10,
    kind: 'notify',
    body: 'x',
    status: over.status ?? 'pending',
    answer: over.answer ?? null,
    wait_token: over.wait_token ?? null,
    delivered_at: over.delivered_at ?? null,
    answered_at: over.answered_at ?? null,
    created_at: over.created_at ?? '2026-05-25T10:00:00Z',
  } as AgentInboxMessage;
}

interface MockState {
  messagesById: Map<number, AgentInboxMessage>;
}

function makeInboxQueue(state: MockState): { queue: InboxQueue; flipStatus: (id: number, status: InboxStatus, answer?: string) => void } {
  const attentionListeners: Array<(ev: { kind: string; role: string }) => void> = [];
  const mockStore = {
    listAgentRuns() { return []; },
    getAgentRun() { return null; },
    listInboxMessages(opts: { companySessionId: number; limit?: number }): AgentInboxMessage[] {
      // Return all messages — InboxQueue.findMessageByWaitToken does
      // its own filter by wait_token from this list.
      if (opts.companySessionId !== COMPANY_SESSION_ID) return [];
      const msgs = [...state.messagesById.values()];
      return typeof opts.limit === 'number' ? msgs.slice(0, opts.limit) : msgs;
    },
    getInboxMessage(id: number): AgentInboxMessage | null {
      return state.messagesById.get(id) ?? null;
    },
    getInboxMessageByWaitToken(companySessionId: number, token: string): AgentInboxMessage | null {
      if (companySessionId !== COMPANY_SESSION_ID) return null;
      for (const m of state.messagesById.values()) {
        if (m.wait_token === token) return m;
      }
      return null;
    },
    getCompanySession() { return null; },
  };
  const publisher = {
    publish() {},
    bus: undefined as unknown,
    markEnded() {},
  } as unknown as IMetaBusPublisher;
  const attention = {
    on(listener: (ev: { kind: string; role: string }) => void): () => void {
      attentionListeners.push(listener);
      return () => {
        const i = attentionListeners.indexOf(listener);
        if (i >= 0) attentionListeners.splice(i, 1);
      };
    },
    signal(ev: { kind: string; role: string }) {
      for (const l of attentionListeners) l(ev);
    },
  };
  const deps: InboxQueueDeps = {
    ctx: {
      companySessionId: COMPANY_SESSION_ID,
      companyStore: mockStore as unknown as InboxQueueDeps['ctx']['companyStore'],
    } as unknown as InboxQueueDeps['ctx'],
    subordinates: {} as unknown as InboxQueueDeps['subordinates'],
    attention: attention as unknown as InboxQueueDeps['attention'],
    publisher,
  };
  const queue = new InboxQueue(deps);
  const flipStatus = (id: number, status: InboxStatus, answer?: string): void => {
    const msg = state.messagesById.get(id);
    if (!msg) return;
    msg.status = status;
    if (answer !== undefined) msg.answer = answer;
    if (msg.wait_token) {
      attention.signal({ kind: 'inbox_answered', role: msg.wait_token });
    }
  };
  return { queue, flipStatus };
}

describe('InboxQueue.waitForAnswer — commit/wake de-race', () => {
  it('resolves immediately when the message was already answered', async () => {
    const msg = makeMessage({ id: 1, status: 'answered', answer: 'the shape is X', wait_token: 'tok-1' });
    const { queue } = makeInboxQueue({ messagesById: new Map([[1, msg]]) });
    // No `flipStatus` / signal fired — the answer pre-exists. Without the
    // de-race, this waiter would park and only reject at the timeout.
    await expect(queue.waitForAnswer('tok-1', 50)).resolves.toBe('the shape is X');
  });

  it('resolves an already-expired token from the DB instead of parking', async () => {
    const msg = makeMessage({ id: 2, status: 'expired', answer: '(no response)', wait_token: 'tok-2' });
    const { queue } = makeInboxQueue({ messagesById: new Map([[2, msg]]) });
    await expect(queue.waitForAnswer('tok-2', 50)).resolves.toContain('no response');
  });

  it('still parks a waiter when the message is pending (normal path)', async () => {
    const msg = makeMessage({ id: 3, status: 'pending', wait_token: 'tok-3' });
    const { queue, flipStatus } = makeInboxQueue({ messagesById: new Map([[3, msg]]) });
    const p = queue.waitForAnswer('tok-3', 1000);
    flipStatus(3, 'answered', 'late answer'); // fires the inbox_answered signal
    await expect(p).resolves.toBe('late answer');
  });
});

describe('InboxQueue.getMessageStatus', () => {
  it('returns null for unknown id', () => {
    const { queue } = makeInboxQueue({ messagesById: new Map() });
    expect(queue.getMessageStatus(999)).toBeNull();
  });

  it('returns current snapshot', () => {
    const msg = makeMessage({ id: 1, status: 'answered', answer: 'done', answered_at: '2026-05-25T11:00:00Z' });
    const { queue } = makeInboxQueue({ messagesById: new Map([[1, msg]]) });
    const snap = queue.getMessageStatus(1);
    expect(snap).toEqual({
      status: 'answered',
      answer: 'done',
      deliveredAt: null,
      answeredAt: '2026-05-25T11:00:00Z',
    });
  });

  it('reflects mutations to the underlying row', () => {
    const msg = makeMessage({ id: 1, status: 'pending' });
    const state: MockState = { messagesById: new Map([[1, msg]]) };
    const { queue } = makeInboxQueue(state);
    expect(queue.getMessageStatus(1)?.status).toBe('pending');
    msg.status = 'delivered';
    expect(queue.getMessageStatus(1)?.status).toBe('delivered');
  });
});

describe('InboxQueue.onMessageAnswered', () => {
  it('fires when status flips to answered (via attention signal)', async () => {
    const msg = makeMessage({ id: 1, status: 'pending', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[1, msg]]) };
    const { queue, flipStatus } = makeInboxQueue(state);

    const events: Array<{ messageId: number; status: string; answer: string | null }> = [];
    queue.onMessageAnswered(1, (ev) => { events.push(ev); });
    // Initial: pending → no fire yet (setImmediate for terminal-state hasn't fired since pending isn't terminal)
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0);

    // Flip to answered.
    flipStatus(1, 'answered', 'OK');
    expect(events).toHaveLength(1);
    expect(events[0].messageId).toBe(1);
    expect(events[0].status).toBe('answered');
    expect(events[0].answer).toBe('OK');
  });

  it('fires once (one-shot) — subsequent signals are ignored', async () => {
    const msg = makeMessage({ id: 1, status: 'pending', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[1, msg]]) };
    const { queue, flipStatus } = makeInboxQueue(state);

    let fireCount = 0;
    queue.onMessageAnswered(1, () => { fireCount++; });

    flipStatus(1, 'answered', 'A');
    flipStatus(1, 'answered', 'B'); // shouldn't re-fire
    expect(fireCount).toBe(1);
  });

  it('fires immediately (next tick) when message is ALREADY answered', async () => {
    const msg = makeMessage({ id: 1, status: 'answered', answer: 'past', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[1, msg]]) };
    const { queue } = makeInboxQueue(state);

    const events: Array<{ status: string; answer: string | null }> = [];
    queue.onMessageAnswered(1, (ev) => { events.push(ev); });
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([{ messageId: 1, status: 'answered', answer: 'past' } as { messageId: number; status: string; answer: string | null }]);
  });

  it('fires for expired status when message starts expired', async () => {
    const msg = makeMessage({ id: 1, status: 'expired', answer: '(timeout)' });
    const state: MockState = { messagesById: new Map([[1, msg]]) };
    const { queue } = makeInboxQueue(state);

    const events: Array<{ status: string }> = [];
    queue.onMessageAnswered(1, (ev) => { events.push(ev); });
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([expect.objectContaining({ status: 'expired' })]);
  });

  it('unsubscribe prevents future fires', async () => {
    const msg = makeMessage({ id: 1, status: 'pending', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[1, msg]]) };
    const { queue, flipStatus } = makeInboxQueue(state);

    let fireCount = 0;
    const unsubscribe = queue.onMessageAnswered(1, () => { fireCount++; });
    unsubscribe();
    flipStatus(1, 'answered', 'OK');
    expect(fireCount).toBe(0);
  });

  it('listener errors are caught — do not propagate to the signal source', async () => {
    const msg = makeMessage({ id: 1, status: 'pending', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[1, msg]]) };
    const { queue, flipStatus } = makeInboxQueue(state);

    queue.onMessageAnswered(1, () => {
      throw new Error('callback threw');
    });
    // Should not throw at the signal site.
    expect(() => flipStatus(1, 'answered')).not.toThrow();
  });
});
