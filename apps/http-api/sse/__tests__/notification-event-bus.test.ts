import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNotificationEventBusForTests,
  latestNotificationRuntimeEventId,
  NOTIFICATION_EVENT_RING_CAPACITY,
  NOTIFICATION_EVENT_RING_TTL_MS,
  publishNotificationRuntimeEvent,
  recentNotificationRuntimeEvents,
  subscribeToNotificationRuntimeEvents,
} from '../notification-event-bus.js';

describe('notification-event-bus', () => {
  beforeEach(() => clearNotificationEventBusForTests());

  it('publishes only notification-worthy events in one global sequence', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToNotificationRuntimeEvents(listener);

    expect(publishNotificationRuntimeEvent({
      kind: 'coder', sessionId: 2, event: 'text_delta', data: { text: 'x' },
    })).toBeNull();
    expect(publishNotificationRuntimeEvent({
      kind: 'coder', sessionId: 2, event: 'agent_progress', data: { event: 'heartbeat' },
    })).toBeNull();
    const done = publishNotificationRuntimeEvent({
      kind: 'coder', sessionId: 2, event: 'done', data: { reason: 'completed' },
    });
    const question = publishNotificationRuntimeEvent({
      kind: 'company', sessionId: 9, event: 'master_question_posted', data: {},
    });

    expect(done?.id).toBe(1);
    expect(question?.id).toBe(2);
    expect(latestNotificationRuntimeEventId()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('replays only entries after the cursor and caps the ring', () => {
    for (let i = 0; i < NOTIFICATION_EVENT_RING_CAPACITY + 5; i += 1) {
      publishNotificationRuntimeEvent({
        kind: 'coder', sessionId: 1, event: 'done', data: { run: i },
      });
    }
    const replay = recentNotificationRuntimeEvents(0);
    expect(replay).toHaveLength(NOTIFICATION_EVENT_RING_CAPACITY);
    expect(replay[0].id).toBe(6);
    expect(recentNotificationRuntimeEvents(replay.at(-2)!.id).map((event) => event.id))
      .toEqual([replay.at(-1)!.id]);
  });

  it('expires old entries instead of accumulating them for a later connection', () => {
    publishNotificationRuntimeEvent({
      kind: 'coder',
      sessionId: 1,
      event: 'error',
      data: { message: 'old' },
      ts: Date.now() - NOTIFICATION_EVENT_RING_TTL_MS - 1,
    });
    expect(recentNotificationRuntimeEvents(0)).toEqual([]);
  });
});
