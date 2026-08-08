import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import {
  drainLocalCoderShadowWrites,
  mirrorLocalCoderToolBoundary,
  resetCoderControlPlaneShadowMetricsForTests,
  snapshotCoderControlPlaneShadowMetrics,
} from '../control-plane-shadow.js';

const context = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  commandId: '00000000-0000-4000-8000-000000000002',
  correlationId: '00000000-0000-4000-8000-000000000003',
  actor: { actorId: 'u', actorType: 'user', source: 'http' },
  agentRunId: '00000000-0000-4000-8000-000000000004',
  attemptId: '00000000-0000-4000-8000-000000000005',
  executorOwnerId: 'worker:1',
  fencingEpoch: 1,
} as never;

describe('control-plane observational write queue', () => {
  beforeEach(() => {
    vi.stubEnv('CODER_CONTROL_PLANE_SHADOW', '1');
    vi.stubEnv('CODER_RUNTIME_JOURNAL_SHADOW', '1');
    resetCoderControlPlaneShadowMetricsForTests();
  });

  afterEach(async () => {
    await drainLocalCoderShadowWrites();
    vi.unstubAllEnvs();
  });

  it('hashes tool values before enqueue and never retains the mutable raw payload', async () => {
    const appendToolBoundary = vi.fn();
    const store = { appendToolBoundary } as never;
    const value = { secret: 'original', nested: { count: 1 } };

    const pending = mirrorLocalCoderToolBoundary(store, context, {
      phase: 'completed',
      toolUseId: 'tool-1',
      toolName: 'read_secret',
      value,
      durationMs: 12,
    });
    value.secret = 'mutated-after-enqueue';
    value.nested.count = 99;

    expect(appendToolBoundary).not.toHaveBeenCalled();
    await pending;
    expect(appendToolBoundary).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        valueHash: hashControlPlanePayload({ secret: 'original', nested: { count: 1 } }),
        durationMs: 12,
      },
    }));
  });

  it('never exceeds the queue cap under a pure observational burst', async () => {
    const appendToolBoundary = vi.fn();
    const store = { appendToolBoundary } as never;
    const pending: Promise<void>[] = [];

    for (let index = 0; index < 2_200; index += 1) {
      pending.push(mirrorLocalCoderToolBoundary(store, context, {
        phase: 'started',
        toolUseId: `tool-${index}`,
        toolName: 'read_file',
        value: { index },
      }));
    }

    expect(snapshotCoderControlPlaneShadowMetrics().queue).toMatchObject({
      depth: 2_048,
      highWatermark: 2_048,
      dropped: 152,
    });
    await Promise.all(pending);
    await drainLocalCoderShadowWrites();
    expect(appendToolBoundary).toHaveBeenCalledTimes(2_048);
    expect(snapshotCoderControlPlaneShadowMetrics().queue.depth).toBe(0);
  });
});
