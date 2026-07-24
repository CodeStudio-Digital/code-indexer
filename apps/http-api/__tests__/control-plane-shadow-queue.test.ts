import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import {
  drainLocalCoderShadowWrites,
  mirrorLocalCoderToolBoundary,
  resetCoderControlPlaneShadowMetricsForTests,
  snapshotCoderControlPlaneShadowMetrics,
} from '../control-plane-shadow.js';

const context = {
  sessionId: 'session:coder:1',
  legacySessionId: 1,
  commandId: 'command:1',
  correlationId: 'correlation:1',
  actor: { actorId: 'u', actorType: 'user', source: 'http' },
  agentRunId: 'agent-run:1',
  attemptId: 'attempt:1',
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
    vi.stubEnv('CODER_RUNTIME_JOURNAL_QUEUE_CAP', '32');
    const appendToolBoundary = vi.fn();
    const store = { appendToolBoundary } as never;
    const pending: Promise<void>[] = [];

    for (let index = 0; index < 100; index += 1) {
      pending.push(mirrorLocalCoderToolBoundary(store, context, {
        phase: 'started',
        toolUseId: `tool-${index}`,
        toolName: 'read_file',
        value: { index },
      }));
    }

    expect(snapshotCoderControlPlaneShadowMetrics().queue).toMatchObject({
      depth: 32,
      highWatermark: 32,
      dropped: 68,
    });
    await Promise.all(pending);
    await drainLocalCoderShadowWrites();
    expect(appendToolBoundary).toHaveBeenCalledTimes(32);
    expect(snapshotCoderControlPlaneShadowMetrics().queue.depth).toBe(0);
  });
});
