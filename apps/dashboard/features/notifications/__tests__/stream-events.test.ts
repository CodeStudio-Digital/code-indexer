import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitAppNotification = vi.hoisted(() => vi.fn());
vi.mock('../dispatcher.js', () => ({ emitAppNotification }));

import { notifyCoderStreamEvent } from '../stream-events.js';

const SESSION_ID = '99999999-9999-4999-8999-999999999999';

describe('notification stream event identity', () => {
  beforeEach(() => emitAppNotification.mockReset());

  it('forwards the runtime identity instead of collapsing repeated run outcomes', () => {
    const target = {
      kind: 'project' as const,
      route: `/projects/2?session=${SESSION_ID}`,
      scopeId: 2,
      sessionId: SESSION_ID,
      label: 'Build',
    };
    notifyCoderStreamEvent(SESSION_ID, 'done', { reason: 'completed' }, {
      target,
      dedupeKey: 'runtime:1000:1',
    });
    notifyCoderStreamEvent(SESSION_ID, 'done', { reason: 'completed' }, {
      target,
      dedupeKey: 'runtime:2000:2',
    });

    expect(emitAppNotification).toHaveBeenCalledTimes(2);
    expect(emitAppNotification.mock.calls.map(([event]) => event.dedupeKey)).toEqual([
      'runtime:1000:1',
      'runtime:2000:2',
    ]);
  });
});
