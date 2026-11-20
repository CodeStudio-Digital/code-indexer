import { beforeEach, describe, expect, it } from 'vitest';
import { getNotifications } from '../session-notifications-store.js';
import {
  recordCoderRuntimeNotification,
  resetRuntimeNotificationStateForTests,
} from '../runtime-events.js';

const TERMINAL_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BACKGROUND_SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('coder runtime notification feed', () => {
  beforeEach(() => resetRuntimeNotificationStateForTests());

  it('records terminal events immediately and dedupes a replayed stream id', () => {
    const event = {
      id: 4,
      ts: 1234,
      sessionId: TERMINAL_SESSION_ID,
      event: 'done',
      data: { reason: 'completed' },
    };
    recordCoderRuntimeNotification(event);
    recordCoderRuntimeNotification(event);

    const items = getNotifications(TERMINAL_SESSION_ID);
    expect(items).toHaveLength(1);
    expect(items[0].receivedAt).toBe(1234);
    expect(items[0].sourceKey).toBe('runtime:1234:4');
    expect(items[0].payload).toEqual({ kind: 'run-done', reason: 'completed' });
  });

  it('raises nothing for agent-group events now that background jobs are gone', () => {
    recordCoderRuntimeNotification({
      id: 10, ts: 10, sessionId: BACKGROUND_SESSION_ID, event: 'agents_group_start',
      data: { groupId: 'g1', background: true, jobId: 'job-1' },
    });
    recordCoderRuntimeNotification({
      id: 11, ts: 11, sessionId: BACKGROUND_SESSION_ID, event: 'agent_progress',
      data: { groupId: 'g1', agentIndex: 2, label: 'Explore', event: 'timed_out' },
    });
    recordCoderRuntimeNotification({
      id: 12, ts: 12, sessionId: BACKGROUND_SESSION_ID, event: 'agents_group_end',
      data: {
        groupId: 'g1', jobId: 'job-1', agentCount: 3, successCount: 1,
        completedCount: 1, partialCount: 1, failedCount: 1, resumableCount: 2,
      },
    });

    expect(getNotifications(BACKGROUND_SESSION_ID)).toEqual([]);
  });
});
