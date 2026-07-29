/**
 * Tests for C8 — InboxMessageWatchdog.
 *
 * Locks in:
 *   - Stuck threshold honored (default + env override)
 *   - Dedup: same stuck message only fires once until clearNotifiedIds()
 *   - Bounded notified set
 *   - Publish errors swallowed (don't break the loop)
 *   - start() is idempotent; stop() cleans up
 *   - startInboxWatchdogIfEnabled honors the env flag
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InboxMessageWatchdog,
  startInboxWatchdogIfEnabled,
  type InboxWatchdogDeps,
} from '../inbox-message-watchdog.js';
import type { AgentInboxMessage } from '@mcp/company-contracts/models/inbox.js';
import type { IMetaBusPublisher } from '../ports.js';

const sessionId = (value: number): string =>
  `c0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const agentRunId = (value: number): string =>
  `a0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const messageId = (value: number): string =>
  `b0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function makeMessage(seq: number, createdMs: number, status: 'pending' | 'delivered' = 'pending'): AgentInboxMessage {
  return {
    id: messageId(seq),
    seq,
    company_session_id: sessionId(1),
    from_agent_run_id: agentRunId(99),
    from_role: 'sender',
    to_role: 'qa',
    to_agent_run_id: agentRunId(10),
    kind: 'notify',
    body: `msg-${seq}`,
    status,
    answer: null,
    wait_token: null,
    delivered_at: null,
    answered_at: null,
    created_at: new Date(createdMs).toISOString(),
  } as AgentInboxMessage;
}

interface MockState {
  sessions: string[];
  messagesBySession: Map<string, AgentInboxMessage[]>;
  publishedEvents: Array<{ topic: string; payload: unknown }>;
  publishErrors?: Set<string>; // topics that should throw
}

function makeDeps(state: MockState, now?: () => number): InboxWatchdogDeps {
  // Mock — only the surface InboxMessageWatchdog calls. The full
  // IMetaBusPublisher includes `bus` + `markEnded` which the watchdog
  // doesn't touch; cast through unknown to satisfy the type.
  const publisher = {
    publish(topic: string, payload: unknown): void {
      if (state.publishErrors?.has(topic)) throw new Error('publish failed');
      state.publishedEvents.push({ topic, payload });
    },
    bus: undefined as unknown as IMetaBusPublisher['bus'],
    markEnded(): void {},
  } as unknown as IMetaBusPublisher;
  return {
    source: {
      listOpenMessages(): AgentInboxMessage[] {
        return state.sessions.flatMap(
          (id) => state.messagesBySession.get(id) ?? [],
        );
      },
    },
    publisher,
    now,
  };
}

describe('InboxMessageWatchdog', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      'MCP_COMPANY_INBOX_WATCHDOG_INTERVAL_MS',
      'MCP_COMPANY_INBOX_WATCHDOG_STUCK_MS',
      'MCP_COMPANY_INBOX_WATCHDOG_ENABLED',
    ]) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('flags messages older than default stuck threshold (5min)', async () => {
    const now = 1000_000_000;
    const TEN_MIN_AGO = now - 10 * 60 * 1000;
    const ONE_MIN_AGO = now - 1 * 60 * 1000;
    const state: MockState = {
      sessions: [sessionId(1)],
      messagesBySession: new Map([
        [sessionId(1), [makeMessage(10, TEN_MIN_AGO), makeMessage(11, ONE_MIN_AGO)]],
      ]),
      publishedEvents: [],
    };
    const wd = new InboxMessageWatchdog(makeDeps(state, () => now));
    const emitted = await wd.scanOnce();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].messageId).toBe(messageId(10));
    expect(emitted[0].ageMs).toBeCloseTo(10 * 60 * 1000, -2);
    expect(state.publishedEvents).toHaveLength(1);
    expect(state.publishedEvents[0].topic).toBe('inbox_message_stuck');
  });

  it('honors MCP_COMPANY_INBOX_WATCHDOG_STUCK_MS override', async () => {
    process.env.MCP_COMPANY_INBOX_WATCHDOG_STUCK_MS = '60000'; // 1 min
    const now = 1000_000_000;
    const TWO_MIN_AGO = now - 2 * 60 * 1000;
    const state: MockState = {
      sessions: [sessionId(1)],
      messagesBySession: new Map([[sessionId(1), [makeMessage(10, TWO_MIN_AGO)]]]),
      publishedEvents: [],
    };
    const wd = new InboxMessageWatchdog(makeDeps(state, () => now));
    const emitted = await wd.scanOnce();
    expect(emitted).toHaveLength(1);
  });

  it('dedupes: same stuck message only fires once across scans', async () => {
    const now = 1000_000_000;
    const OLD = now - 10 * 60 * 1000;
    const state: MockState = {
      sessions: [sessionId(1)],
      messagesBySession: new Map([[sessionId(1), [makeMessage(10, OLD)]]]),
      publishedEvents: [],
    };
    const wd = new InboxMessageWatchdog(makeDeps(state, () => now));
    await wd.scanOnce();
    await wd.scanOnce();
    await wd.scanOnce();
    expect(state.publishedEvents).toHaveLength(1);
    expect(wd.hasNotified(messageId(10))).toBe(true);
  });

  it('clearNotifiedIds() lets a stuck message re-notify', async () => {
    const now = 1000_000_000;
    const OLD = now - 10 * 60 * 1000;
    const state: MockState = {
      sessions: [sessionId(1)],
      messagesBySession: new Map([[sessionId(1), [makeMessage(10, OLD)]]]),
      publishedEvents: [],
    };
    const wd = new InboxMessageWatchdog(makeDeps(state, () => now));
    await wd.scanOnce();
    wd.clearNotifiedIds();
    await wd.scanOnce();
    expect(state.publishedEvents).toHaveLength(2);
  });

  it('publish errors are swallowed; subsequent messages still emit', async () => {
    const now = 1000_000_000;
    const OLD = now - 10 * 60 * 1000;
    const state: MockState = {
      sessions: [sessionId(1)],
      messagesBySession: new Map([[sessionId(1), [makeMessage(10, OLD), makeMessage(11, OLD)]]]),
      publishedEvents: [],
      publishErrors: new Set(['inbox_message_stuck']),
    };
    const wd = new InboxMessageWatchdog(makeDeps(state, () => now));
    const emitted = await wd.scanOnce();
    // Both emitted internally (returned by scanOnce) even though
    // publish errored — the loop didn't break.
    expect(emitted).toHaveLength(2);
  });

  it('flags delivered messages too (not just pending)', async () => {
    const now = 1000_000_000;
    const OLD = now - 10 * 60 * 1000;
    const state: MockState = {
      sessions: [sessionId(1)],
      messagesBySession: new Map([
        [sessionId(1), [makeMessage(10, OLD, 'delivered')]],
      ]),
      publishedEvents: [],
    };
    const wd = new InboxMessageWatchdog(makeDeps(state, () => now));
    const emitted = await wd.scanOnce();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].status).toBe('delivered');
  });

  it('skips messages with non-parseable created_at', async () => {
    const now = 1000_000_000;
    const badMsg = makeMessage(10, 0);
    badMsg.created_at = 'not-a-date';
    const state: MockState = {
      sessions: [sessionId(1)],
      messagesBySession: new Map([[sessionId(1), [badMsg]]]),
      publishedEvents: [],
    };
    const wd = new InboxMessageWatchdog(makeDeps(state, () => now));
    const emitted = await wd.scanOnce();
    expect(emitted).toHaveLength(0);
  });

  it('start() is idempotent — calling twice does not spawn two intervals', () => {
    vi.useFakeTimers();
    const state: MockState = {
      sessions: [],
      messagesBySession: new Map(),
      publishedEvents: [],
    };
    const wd = new InboxMessageWatchdog(makeDeps(state));
    wd.start();
    wd.start();
    expect(wd.getScanCount()).toBe(1); // initial scan only
    vi.advanceTimersByTime(30_000);
    expect(wd.getScanCount()).toBe(2);
    wd.stop();
    vi.useRealTimers();
  });

  it('stop() is idempotent — safe to call twice', () => {
    const wd = new InboxMessageWatchdog(
      makeDeps({ sessions: [], messagesBySession: new Map(), publishedEvents: [] }),
    );
    wd.stop();
    wd.stop();
    expect(true).toBe(true); // no throw
  });

  it('startInboxWatchdogIfEnabled returns null when env flag unset', () => {
    const state: MockState = {
      sessions: [],
      messagesBySession: new Map(),
      publishedEvents: [],
    };
    const wd = startInboxWatchdogIfEnabled(makeDeps(state));
    expect(wd).toBeNull();
  });

  it('startInboxWatchdogIfEnabled creates and starts watchdog when env flag set', () => {
    process.env.MCP_COMPANY_INBOX_WATCHDOG_ENABLED = '1';
    const state: MockState = {
      sessions: [],
      messagesBySession: new Map(),
      publishedEvents: [],
    };
    const wd = startInboxWatchdogIfEnabled(makeDeps(state));
    expect(wd).toBeInstanceOf(InboxMessageWatchdog);
    expect(wd?.getScanCount()).toBeGreaterThanOrEqual(1);
    wd?.stop();
  });
});
