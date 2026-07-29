import { create } from '@bufbuild/protobuf';
import { agentV1Common } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import type {
  DurableSupervisorFactCommitControl,
  SupervisorLifecycleFact,
} from '../driver/HostSupervisorFactTypes.js';
import {
  acceptedFact,
  containmentFact,
  containmentProof,
  factFrame,
  harness,
  rejectedFact,
  runnerProvenance,
  spawnedFact,
} from './host-supervisor-fact-support.js';
import { resourceBudget } from './attempt-channel-support.js';

function port() {
  return { commit: vi.fn(async () => undefined) };
}

async function rejectSecond(fact: SupervisorLifecycleFact) {
  const durable = port();
  const attempt = harness([
    factFrame(acceptedFact(), 'accepted', 2n),
    factFrame(fact, 'second', 3n),
  ], durable);
  await attempt.driver.processNext();
  await expect(attempt.driver.processNext()).rejects.toMatchObject({
    code: 'invalid_fact',
  });
  expect(durable.commit).toHaveBeenCalledTimes(1);
  expect(attempt.capture.frames()).toHaveLength(1);
}

async function rejectThird(fact: SupervisorLifecycleFact) {
  const durable = port();
  const attempt = harness([
    factFrame(acceptedFact(), 'accepted', 2n),
    factFrame(spawnedFact(), 'spawned', 3n),
    factFrame(fact, 'third', 4n),
  ], durable);
  await attempt.driver.processNext();
  await attempt.driver.processNext();
  await expect(attempt.driver.processNext()).rejects.toMatchObject({
    code: 'invalid_fact',
  });
  expect(durable.commit).toHaveBeenCalledTimes(2);
  expect(attempt.capture.frames()).toHaveLength(2);
}

describe('supervisor launch authority validation', () => {
  it.each([
    {
      expectedResourceBudget: resourceBudget({
        maxProcesses: 17,
        maxThreads: 16,
      }),
    },
    {
      expectedResourceBudget: resourceBudget({
        maxSpoolBytes: 16n,
        maxArtifactBytes: 17n,
      }),
    },
    {
      expectedResourceBudget: resourceBudget({
        hardMemoryBytes: 9n * 1024n * 1024n * 1024n,
      }),
    },
    {
      expectedResourceBudget: resourceBudget({
        maxProcesses: 65,
        maxThreads: 65,
      }),
    },
    {
      expectedResourceBudget: resourceBudget({ maxWallMs: 69_996n }),
    },
  ])(
    'rejects invalid or unauthorized budget authority in the constructor',
    (handoff) => {
      const durable = port();
      let transport:
        | import('../ipc/DelimitedByteChannel.js').DelimitedByteChannel
        | undefined;
      expect(() => harness([], durable, {
        observeTransport: (value) => { transport = value; },
        driver: { handoff },
      })).toThrow(expect.objectContaining({ code: 'invalid_handoff' }));
      expect(durable.commit).not.toHaveBeenCalled();
      expect(transport?.isFailed).toBe(true);
    },
  );

  it.each([
    acceptedFact({
      reservedBudget: resourceBudget({ maxProcesses: 17 }),
    }),
    acceptedFact({ hardDeadlineAtUnixMs: 999n }),
  ])('rejects accepted budget or deadline drift before durability', async (fact) => {
    const durable = port();
    const attempt = harness([factFrame(fact, 'accepted', 2n)], durable);
    await expect(attempt.driver.processNext()).rejects.toMatchObject({
      code: 'invalid_fact',
    });
    expect(durable.commit).not.toHaveBeenCalled();
    expect(attempt.capture.frames()).toHaveLength(0);
  });

  it.each([
    runnerProvenance({ buildId: 'foreign' }),
    runnerProvenance({ sourceCommit: 'foreign' }),
    runnerProvenance({ binarySha256: new Uint8Array(31) }),
    runnerProvenance({ operatingSystem: 'linux' }),
    runnerProvenance({ architecture: 'arm64' }),
    runnerProvenance({ runtimeInstanceId: '' }),
    runnerProvenance({ pid: 0 }),
  ])('rejects incomplete or foreign spawned provenance', async (provenance) => {
    await rejectSecond(spawnedFact({ runnerProvenance: provenance }));
  });

  it.each([
    [['control', 'data']],
    [['control', 'data', 'data']],
    [['control', 'data', 'foreign']],
  ])('rejects endpoint IDs that are not the exact unique set', async (ids) => {
    await rejectSecond(spawnedFact({ endpointIds: ids }));
  });

  it.each([
    containmentFact({
      requestedBudget: resourceBudget({ maxProcesses: 17 }),
    }),
    containmentFact({
      effectiveContainment: containmentProof({
        level: agentV1Common.ContainmentLevel.MONITORED,
      }),
    }),
    containmentFact({
      effectiveContainment: containmentProof({ unsupportedLimits: [] }),
    }),
    containmentFact({
      effectiveContainment: containmentProof({
        unsupportedLimits: [
          agentV1Common.ResourceLimitKind.MEMORY,
          agentV1Common.ResourceLimitKind.CPU_TIME,
          agentV1Common.ResourceLimitKind.WALL_TIME,
          agentV1Common.ResourceLimitKind.PROCESSES,
          agentV1Common.ResourceLimitKind.THREADS,
          agentV1Common.ResourceLimitKind.OPEN_HANDLES,
          agentV1Common.ResourceLimitKind.SCRATCH_BYTES,
        ],
      }),
    }),
    containmentFact({
      effectiveContainment: containmentProof({
        capabilities: create(
          agentV1Common.ContainmentCapabilitiesSchema,
          { processTree: true, memoryLimit: false },
        ),
      }),
    }),
    containmentFact({
      effectiveContainment: containmentProof({
        enforcedLimits: [agentV1Common.ResourceLimitKind.CPU_TIME],
        capabilities: create(
          agentV1Common.ContainmentCapabilitiesSchema,
          { processTree: true, cpuLimit: true },
        ),
        unsupportedLimits: [
          agentV1Common.ResourceLimitKind.MEMORY,
          agentV1Common.ResourceLimitKind.WALL_TIME,
          agentV1Common.ResourceLimitKind.PROCESSES,
          agentV1Common.ResourceLimitKind.THREADS,
          agentV1Common.ResourceLimitKind.OPEN_HANDLES,
          agentV1Common.ResourceLimitKind.SCRATCH_BYTES,
        ],
      }),
    }),
  ])('rejects containment budget, level, partition, or capability drift', async (fact) => {
    await rejectThird(fact);
  });

  it('commits the complete accepted, spawned, containment sequence', async () => {
    const durable = port();
    const attempt = harness([
      factFrame(acceptedFact(), 'accepted', 2n),
      factFrame(spawnedFact(), 'spawned', 3n),
      factFrame(containmentFact(), 'containment', 4n),
    ], durable);

    await attempt.driver.processNext();
    await attempt.driver.processNext();
    await attempt.driver.processNext();

    expect(durable.commit).toHaveBeenCalledTimes(3);
    expect(attempt.capture.frames()).toHaveLength(3);
  });

  it('times out a durable commit without an AbortSignal or ACK', async () => {
    let release!: () => void;
    const lateCompletion = new Promise<void>((resolve) => {
      release = resolve;
    });
    let control: DurableSupervisorFactCommitControl | undefined;
    const durable = {
      commit: vi.fn((
        _fact,
        _binding,
        value: DurableSupervisorFactCommitControl,
      ) => {
        control = value;
        return lateCompletion;
      }),
    };
    const attempt = harness(
      [factFrame(acceptedFact(), 'accepted', 2n)],
      durable,
      { driver: { durableCommitTimeoutMs: 5 } },
    );

    await expect(attempt.driver.processNext()).rejects.toMatchObject({
      code: 'durable_commit_timeout',
    });
    expect(control?.signal.aborted).toBe(true);
    expect(control?.signal.reason).toMatchObject({
      code: 'durable_commit_timeout',
    });
    expect(attempt.capture.frames()).toHaveLength(0);
    expect(attempt.driver.isPoisoned).toBe(true);
    release();
    await lateCompletion;
    await Promise.resolve();
    expect(attempt.capture.frames()).toHaveLength(0);
    expect(attempt.driver.isPoisoned).toBe(true);
  });

  it.each([
    {
      maximumFrameBytes: 1_000,
      maximumReplayBytes: 800,
      code: 'ack_frame_too_large',
    },
    {
      maximumFrameBytes: 2_000,
      maximumReplayBytes: 800,
      code: 'replay_capacity_exhausted',
    },
  ])(
    'rejects an ACK that cannot fit the negotiated frame or replay cap',
    async ({ maximumFrameBytes, maximumReplayBytes, code }) => {
      const inbound = factFrame(
        rejectedFact({ reasonCode: 'r'.repeat(84) }),
        'm'.repeat(492),
        2n,
      );
      expect(inbound.byteLength).toBe(947);
      const durable = port();
      const attempt = harness([inbound], durable, {
        transportMaximum: maximumFrameBytes,
        driver: {
          handoff: { maximumFrameBytes, maximumReplayBytes },
        },
      });

      await expect(attempt.driver.processNext()).rejects.toMatchObject({
        code,
        message: expect.stringContaining(
          code === 'ack_frame_too_large' ? 'upper bound' : 'capacity',
        ),
      });
      expect(durable.commit).not.toHaveBeenCalled();
      expect(attempt.capture.frames()).toHaveLength(0);
    },
  );

  it('replays the cached ACK after expiry but rejects an invalid replay clock', async () => {
    const replayBudget = resourceBudget({
      maxWallMs: 50n,
      cancelGraceMs: 10n,
    });
    const inbound = factFrame(
      acceptedFact({
        hardDeadlineAtUnixMs: 100n,
        reservedBudget: replayBudget,
      }),
      'accepted',
      2n,
      { deadlineAtUnixMs: 100n },
    );
    const times = [50n, 50n, 50n, 101n];
    const durable = port();
    const replay = harness([inbound, inbound], durable, {
      driver: {
        handoff: {
          expectedHardDeadlineAtUnixMs: 100n,
          expectedResourceBudget: replayBudget,
        },
        nowUnixMs: () => times.shift()!,
      },
    });
    await replay.driver.processNext();
    await expect(replay.driver.processNext()).resolves.toMatchObject({
      kind: 'replayed',
    });
    expect(durable.commit).toHaveBeenCalledOnce();
    expect(replay.capture.frames()[1]).toEqual(replay.capture.frames()[0]);

    const badTimes = [50n, 50n, 50n, 0n];
    const invalid = harness([inbound, inbound], port(), {
      driver: {
        handoff: {
          expectedHardDeadlineAtUnixMs: 100n,
          expectedResourceBudget: replayBudget,
        },
        nowUnixMs: () => badTimes.shift()!,
      },
    });
    await invalid.driver.processNext();
    await expect(invalid.driver.processNext()).rejects.toMatchObject({
      code: 'invalid_header',
    });
    expect(invalid.capture.frames()).toHaveLength(1);
  });

  it('rejects fresh expiry before durability', async () => {
    const durable = port();
    const attempt = harness([
      factFrame(
        rejectedFact(),
        'rejected',
        2n,
        { deadlineAtUnixMs: 10n },
      ),
    ], durable, { driver: { nowUnixMs: () => 10n } });
    await expect(attempt.driver.processNext()).rejects.toMatchObject({
      code: 'invalid_header',
    });
    expect(durable.commit).not.toHaveBeenCalled();
  });
});
