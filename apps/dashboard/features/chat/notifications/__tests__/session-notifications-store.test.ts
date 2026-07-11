import { describe, expect, it } from 'vitest';
import {
  clearNotifications,
  dismissAllActive,
  dismissNotification,
  getActiveNotifications,
  getNotifications,
  getUnreadCount,
  markAllRead,
  pushNotification,
} from '../session-notifications-store.js';
import type { ToolLoopIntervention } from '../../../../hooks/agent-stream/types.js';

// The store is module-global; each test uses a distinct session id so state
// from one case never leaks into another.
let nextSid = 9000;
const sid = () => ++nextSid;

function failureStreak(severity: 'informational' | 'refused'): ToolLoopIntervention {
  return {
    kind: 'failure-streak',
    turn: 5,
    toolName: 'run_command',
    count: severity === 'refused' ? 5 : 3,
    firstFailureTurn: 1,
    lastError: 'boom',
    severity,
    reason: 'failed',
    receivedAt: 0,
  };
}

describe('session-notifications-store', () => {
  it('appends notifications newest-last and exposes them', () => {
    const s = sid();
    pushNotification(s, { kind: 'run-error', message: 'first' });
    pushNotification(s, { kind: 'run-error', message: 'second' });
    const all = getNotifications(s);
    expect(all.map((n) => (n.payload as { message: string }).message)).toEqual([
      'first',
      'second',
    ]);
  });

  it('dismiss removes from active but keeps history', () => {
    const s = sid();
    const id = pushNotification(s, { kind: 'run-error', message: 'x' });
    expect(getActiveNotifications(s)).toHaveLength(1);
    dismissNotification(s, id);
    expect(getActiveNotifications(s)).toHaveLength(0);
    expect(getNotifications(s)).toHaveLength(1); // still in history
  });

  it('derives severity + auto-dismiss budget per payload kind', () => {
    const cases: Array<{
      payload: Parameters<typeof pushNotification>[1];
      severity: string;
      autoDismissMs: number | null;
    }> = [
      { payload: { kind: 'tool-loop', intervention: failureStreak('informational') }, severity: 'info', autoDismissMs: 10_000 },
      { payload: { kind: 'tool-loop', intervention: failureStreak('refused') }, severity: 'warning', autoDismissMs: 20_000 },
      { payload: { kind: 'run-error', message: 'e' }, severity: 'error', autoDismissMs: null },
      { payload: { kind: 'run-done', reason: 'completed' }, severity: 'info', autoDismissMs: 10_000 },
      { payload: { kind: 'run-done', reason: 'crash', error: 'oops' }, severity: 'error', autoDismissMs: null },
      { payload: { kind: 'quality-alert', verdict: 'warn', suspectTool: 't', reason: 'r', turn: 1 }, severity: 'warning', autoDismissMs: 20_000 },
      { payload: { kind: 'quality-alert', verdict: 'error', suspectTool: 't', reason: 'r', turn: 1 }, severity: 'error', autoDismissMs: null },
    ];
    for (const c of cases) {
      const s = sid();
      pushNotification(s, c.payload);
      const n = getNotifications(s)[0];
      expect(n.severity, JSON.stringify(c.payload)).toBe(c.severity);
      expect(n.autoDismissMs, JSON.stringify(c.payload)).toBe(c.autoDismissMs);
    }
  });

  it('tracks unread and clears it on markAllRead', () => {
    const s = sid();
    pushNotification(s, { kind: 'run-error', message: 'a' });
    pushNotification(s, { kind: 'run-error', message: 'b' });
    expect(getUnreadCount(s)).toBe(2);
    markAllRead(s);
    expect(getUnreadCount(s)).toBe(0);
    // dismissing does NOT change read state
    pushNotification(s, { kind: 'run-error', message: 'c' });
    expect(getUnreadCount(s)).toBe(1);
  });

  it('caps history at 100, dropping the oldest', () => {
    const s = sid();
    for (let i = 0; i < 105; i += 1) pushNotification(s, { kind: 'run-error', message: `m${i}` });
    const all = getNotifications(s);
    expect(all).toHaveLength(100);
    expect((all[0].payload as { message: string }).message).toBe('m5');
    expect((all[99].payload as { message: string }).message).toBe('m104');
  });

  it('dismissAllActive and clearNotifications', () => {
    const s = sid();
    pushNotification(s, { kind: 'run-error', message: 'a' });
    pushNotification(s, { kind: 'run-error', message: 'b' });
    dismissAllActive(s);
    expect(getActiveNotifications(s)).toHaveLength(0);
    expect(getNotifications(s)).toHaveLength(2);
    clearNotifications(s);
    expect(getNotifications(s)).toHaveLength(0);
  });

});
