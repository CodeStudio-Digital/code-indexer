import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitAppNotification = vi.hoisted(() => vi.fn());
vi.mock('../dispatcher.js', () => ({ emitAppNotification }));

import { notifyCoderStreamEvent } from '../stream-events.js';

describe('notification stream event identity', () => {
  beforeEach(() => emitAppNotification.mockReset());

  it('forwards the runtime identity instead of collapsing repeated run outcomes', () => {
    const target = {
      kind: 'project' as const,
      route: '/projects/2?session=9',
      scopeId: 2,
      sessionId: 9,
      label: 'Build',
    };
    notifyCoderStreamEvent(9, 'done', { reason: 'completed' }, {
      target,
      dedupeKey: 'runtime:1000:1',
    });
    notifyCoderStreamEvent(9, 'done', { reason: 'completed' }, {
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
