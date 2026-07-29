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

const COMPANY_SESSION_ID = 'c0000000-0000-4000-8000-000000000100';
const SENDER_RUN_ID = 'a0000000-0000-4000-8000-000000000099';
const TARGET_RUN_ID = 'a0000000-0000-4000-8000-000000000010';
const messageId = (n: number): string =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function makeMessage(over: Partial<AgentInboxMessage> & Pick<AgentInboxMessage, 'id'>): AgentInboxMessage {
  return {
    id: over.id,
    seq: over.seq ?? 1,
    company_session_id: COMPANY_SESSION_ID,
    from_agent_run_id: SENDER_RUN_ID,
    from_role: 'sender',
    to_role: 'qa',
    to_agent_run_id: TARGET_RUN_ID,
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
  messagesById: Map<string, AgentInboxMessage>;
}

function makeInboxQueue(state: MockState): { queue: InboxQueue; flipStatus: (id: string, status: InboxStatus, answer?: string) => void } {
  const attentionListeners: Array<(ev: { kind: string; role: string }) => void> = [];
  const companyFiles = {
    listAgentRunsSync() { return []; },
    getAgentRunSync() { return null; },
    listInboxMessagesSync(opts: { limit?: number }): AgentInboxMessage[] {
      const msgs = [...state.messagesById.values()];
      return typeof opts.limit === 'number' ? msgs.slice(0, opts.limit) : msgs;
    },
    getInboxMessageSync(id: string): AgentInboxMessage | null {
      return state.messagesById.get(id) ?? null;
    },
    getInboxMessageByWaitTokenSync(token: string): AgentInboxMessage | null {
      for (const m of state.messagesById.values()) {
        if (m.wait_token === token) return m;
      }
      return null;
    },
    getSession() {
      return { id: COMPANY_SESSION_ID, name: 'test' };
    },
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
      companyFiles,
    } as unknown as InboxQueueDeps['ctx'],
    subordinates: {} as unknown as InboxQueueDeps['subordinates'],
    attention: attention as unknown as InboxQueueDeps['attention'],
    publisher,
  };
  const queue = new InboxQueue(deps);
  const flipStatus = (id: string, status: InboxStatus, answer?: string): void => {
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
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'answered', answer: 'the shape is X', wait_token: 'tok-1' });
    const { queue } = makeInboxQueue({ messagesById: new Map([[id, msg]]) });
    // No `flipStatus` / signal fired — the answer pre-exists. Without the
    // de-race, this waiter would park and only reject at the timeout.
    await expect(queue.waitForAnswer('tok-1', 50)).resolves.toBe('the shape is X');
  });

  it('resolves an already-expired token from the DB instead of parking', async () => {
    const id = messageId(2);
    const msg = makeMessage({ id, status: 'expired', answer: '(no response)', wait_token: 'tok-2' });
    const { queue } = makeInboxQueue({ messagesById: new Map([[id, msg]]) });
    await expect(queue.waitForAnswer('tok-2', 50)).resolves.toContain('no response');
  });

  it('still parks a waiter when the message is pending (normal path)', async () => {
    const id = messageId(3);
    const msg = makeMessage({ id, status: 'pending', wait_token: 'tok-3' });
    const { queue, flipStatus } = makeInboxQueue({ messagesById: new Map([[id, msg]]) });
    const p = queue.waitForAnswer('tok-3', 1000);
    flipStatus(id, 'answered', 'late answer'); // fires the inbox_answered signal
    await expect(p).resolves.toBe('late answer');
  });
});

describe('InboxQueue.getMessageStatus', () => {
  it('returns null for unknown id', () => {
    const { queue } = makeInboxQueue({ messagesById: new Map() });
    expect(queue.getMessageStatus(messageId(999))).toBeNull();
  });

  it('returns current snapshot', () => {
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'answered', answer: 'done', answered_at: '2026-05-25T11:00:00Z' });
    const { queue } = makeInboxQueue({ messagesById: new Map([[id, msg]]) });
    const snap = queue.getMessageStatus(id);
    expect(snap).toEqual({
      status: 'answered',
      answer: 'done',
      deliveredAt: null,
      answeredAt: '2026-05-25T11:00:00Z',
    });
  });

  it('reflects mutations to the underlying row', () => {
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'pending' });
    const state: MockState = { messagesById: new Map([[id, msg]]) };
    const { queue } = makeInboxQueue(state);
    expect(queue.getMessageStatus(id)?.status).toBe('pending');
    msg.status = 'delivered';
    expect(queue.getMessageStatus(id)?.status).toBe('delivered');
  });
});

describe('InboxQueue.onMessageAnswered', () => {
  it('fires when status flips to answered (via attention signal)', async () => {
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'pending', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[id, msg]]) };
    const { queue, flipStatus } = makeInboxQueue(state);

    const events: Array<{ messageId: string; status: string; answer: string | null }> = [];
    queue.onMessageAnswered(id, (ev) => { events.push(ev); });
    // Initial: pending → no fire yet (setImmediate for terminal-state hasn't fired since pending isn't terminal)
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0);

    // Flip to answered.
    flipStatus(id, 'answered', 'OK');
    expect(events).toHaveLength(1);
    expect(events[0].messageId).toBe(id);
    expect(events[0].status).toBe('answered');
    expect(events[0].answer).toBe('OK');
  });

  it('fires once (one-shot) — subsequent signals are ignored', async () => {
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'pending', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[id, msg]]) };
    const { queue, flipStatus } = makeInboxQueue(state);

    let fireCount = 0;
    queue.onMessageAnswered(id, () => { fireCount++; });

    flipStatus(id, 'answered', 'A');
    flipStatus(id, 'answered', 'B'); // shouldn't re-fire
    expect(fireCount).toBe(1);
  });

  it('fires immediately (next tick) when message is ALREADY answered', async () => {
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'answered', answer: 'past', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[id, msg]]) };
    const { queue } = makeInboxQueue(state);

    const events: Array<{ messageId: string; status: string; answer: string | null }> = [];
    queue.onMessageAnswered(id, (ev) => { events.push(ev); });
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([{ messageId: id, status: 'answered', answer: 'past' }]);
  });

  it('fires for expired status when message starts expired', async () => {
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'expired', answer: '(timeout)' });
    const state: MockState = { messagesById: new Map([[id, msg]]) };
    const { queue } = makeInboxQueue(state);

    const events: Array<{ status: string }> = [];
    queue.onMessageAnswered(id, (ev) => { events.push(ev); });
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([expect.objectContaining({ status: 'expired' })]);
  });

  it('unsubscribe prevents future fires', async () => {
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'pending', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[id, msg]]) };
    const { queue, flipStatus } = makeInboxQueue(state);

    let fireCount = 0;
    const unsubscribe = queue.onMessageAnswered(id, () => { fireCount++; });
    unsubscribe();
    flipStatus(id, 'answered', 'OK');
    expect(fireCount).toBe(0);
  });

  it('listener errors are caught — do not propagate to the signal source', async () => {
    const id = messageId(1);
    const msg = makeMessage({ id, status: 'pending', wait_token: 'tok-1' });
    const state: MockState = { messagesById: new Map([[id, msg]]) };
    const { queue, flipStatus } = makeInboxQueue(state);

    queue.onMessageAnswered(id, () => {
      throw new Error('callback threw');
    });
    // Should not throw at the signal site.
    expect(() => flipStatus(id, 'answered')).not.toThrow();
  });
});
