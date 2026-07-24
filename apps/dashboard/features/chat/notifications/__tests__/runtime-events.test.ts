import { beforeEach, describe, expect, it } from 'vitest';
import { getNotifications } from '../session-notifications-store.js';
import {
  recordCoderRuntimeNotification,
  resetRuntimeNotificationStateForTests,
} from '../runtime-events.js';

let nextSessionId = 20_000;

describe('coder runtime notification feed', () => {
  beforeEach(() => resetRuntimeNotificationStateForTests());

  it('records terminal events immediately and dedupes a replayed stream id', () => {
    const sessionId = ++nextSessionId;
    const event = {
      id: 4,
      ts: 1234,
      sessionId,
      event: 'done',
      data: { reason: 'completed' },
    };
    recordCoderRuntimeNotification(event);
    recordCoderRuntimeNotification(event);

    const items = getNotifications(sessionId);
    expect(items).toHaveLength(1);
    expect(items[0].receivedAt).toBe(1234);
    expect(items[0].sourceKey).toBe('runtime:1234:4');
    expect(items[0].payload).toEqual({ kind: 'run-done', reason: 'completed' });
  });

  it('tracks background groups while the conversation route is closed', () => {
    const sessionId = ++nextSessionId;
    recordCoderRuntimeNotification({
      id: 10, ts: 10, sessionId, event: 'agents_group_start',
      data: { groupId: 'g1', background: true, jobId: 'job-1' },
    });
    recordCoderRuntimeNotification({
      id: 11, ts: 11, sessionId, event: 'agent_progress',
      data: { groupId: 'g1', agentIndex: 2, label: 'Explore', event: 'timed_out' },
    });
    recordCoderRuntimeNotification({
      id: 12, ts: 12, sessionId, event: 'agents_group_end',
      data: {
        groupId: 'g1', jobId: 'job-1', agentCount: 3, successCount: 1,
        completedCount: 1, partialCount: 1, failedCount: 1, resumableCount: 2,
      },
    });

    expect(getNotifications(sessionId).map((item) => item.payload.kind)).toEqual([
      'background-agents-done',
    ]);
    expect(getNotifications(sessionId)[0].payload).toEqual({
      kind: 'background-agents-done',
      jobId: 'job-1',
      groupId: 'g1',
      agentCount: 3,
      successCount: 1,
      completedCount: 1,
      partialCount: 1,
      failedCount: 1,
      resumableCount: 2,
    });
  });
});
