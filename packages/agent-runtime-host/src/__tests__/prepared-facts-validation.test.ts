import { create } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import {
  validatePreparedFacts,
} from '../driver/PreparedFactsValidation.js';
import type {
  PreparedFactsExpectation,
} from '../driver/HostLifecycleTypes.js';
import {
  RUNTIME,
  preparedArtifacts,
  preparedContainment,
  preparedSnapshots,
} from './host-lifecycle-driver-support.js';
import {
  identity,
  resourceBudget,
} from './attempt-channel-support.js';

function expectation(): PreparedFactsExpectation {
  return {
    expectedSnapshots: preparedSnapshots(),
    expectedArtifacts: preparedArtifacts(),
    resourceBudget: resourceBudget(),
    requiredContainmentLevel:
      agentV1Common.ContainmentLevel.HARD_PROCESS,
    requiredEnforcedLimits: [
      agentV1Common.ResourceLimitKind.MEMORY,
    ],
    runtimeInstanceId: RUNTIME,
    ownerSessionId: identity().sessionId,
  };
}

function prepared(overrides: {
  loadedSnapshots?: agentV1Common.SnapshotRef[];
  validatedArtifacts?: agentV1Artifact.ArtifactRef[];
  effectiveResourceBudget?: agentV1Common.ResourceBudget;
  effectiveContainment?: agentV1Common.ContainmentReport;
} = {}) {
  return create(agentV1Runtime.AttemptPreparedSchema, {
    identity: identity(),
    runtimeInstanceId: RUNTIME,
    specSha256: new Uint8Array(32),
    loadedSnapshots: preparedSnapshots(),
    validatedArtifacts: preparedArtifacts(),
    effectiveResourceBudget: resourceBudget(),
    effectiveContainment: preparedContainment(),
    readyAtUnixMs: 10n,
    ...overrides,
  });
}

function containment(overrides: {
  level?: agentV1Common.ContainmentLevel;
  enforcedLimits?: agentV1Common.ResourceLimitKind[];
  unsupportedLimits?: agentV1Common.ResourceLimitKind[];
  capabilities?: agentV1Common.ContainmentCapabilities;
}) {
  return create(agentV1Common.ContainmentReportSchema, {
    ...preparedContainment(),
    ...overrides,
  });
}

describe('prepared facts validation', () => {
  it('treats manifest order as non-authoritative', () => {
    expect(() => validatePreparedFacts(prepared({
      loadedSnapshots: preparedSnapshots().reverse(),
      validatedArtifacts: preparedArtifacts().reverse(),
      effectiveContainment: containment({
        level: agentV1Common.ContainmentLevel.HARD_AGGREGATE,
      }),
    }), expectation())).not.toThrow();
  });

  it.each([
    [
      'overlapping limits',
      containment({
        enforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
        unsupportedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
      }),
    ],
    [
      'unknown limit',
      containment({
        enforcedLimits: [
          999 as agentV1Common.ResourceLimitKind,
        ],
      }),
    ],
    [
      'duplicated limit',
      containment({
        enforcedLimits: [
          agentV1Common.ResourceLimitKind.MEMORY,
          agentV1Common.ResourceLimitKind.MEMORY,
        ],
      }),
    ],
    [
      'unknown level',
      containment({
        level: 999 as agentV1Common.ContainmentLevel,
      }),
    ],
    [
      'unsupported capability claim',
      containment({
        enforcedLimits: [
          agentV1Common.ResourceLimitKind.MEMORY,
          agentV1Common.ResourceLimitKind.PROCESSES,
        ],
      }),
    ],
    [
      'incomplete limit partition',
      containment({
        unsupportedLimits: [],
      }),
    ],
    [
      'unsupported limit with an applied capability',
      containment({
        enforcedLimits: [],
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
    ],
    [
      'hard process without process-tree ownership',
      containment({
        capabilities: create(
          agentV1Common.ContainmentCapabilitiesSchema,
          { memoryLimit: true },
        ),
      }),
    ],
  ])('rejects containment with %s', (_name, effectiveContainment) => {
    expect(() => validatePreparedFacts(
      prepared({ effectiveContainment }),
      expectation(),
    )).toThrow(expect.objectContaining({
      code: 'prepared_facts_mismatch',
    }));
  });

  it('rejects duplicate snapshot refs', () => {
    const snapshots = preparedSnapshots();
    snapshots.push(create(agentV1Common.SnapshotRefSchema, snapshots[0]!));
    expect(() => validatePreparedFacts(
      prepared({ loadedSnapshots: snapshots }),
      expectation(),
    )).toThrow(expect.objectContaining({
      code: 'prepared_facts_mismatch',
    }));
  });

  it.each([
    ['duplicate id', (values: agentV1Artifact.ArtifactRef[]) => {
      values.push(create(agentV1Artifact.ArtifactRefSchema, values[0]!));
    }],
    ['wrong owner', (values: agentV1Artifact.ArtifactRef[]) => {
      values[0]!.ownerSessionId = 'other-session';
    }],
    ['zero length', (values: agentV1Artifact.ArtifactRef[]) => {
      values[0]!.byteLength = 0n;
    }],
    ['unknown enum', (values: agentV1Artifact.ArtifactRef[]) => {
      values[0]!.compression = 999 as agentV1Artifact.ArtifactCompression;
    }],
    ['oversized item', (values: agentV1Artifact.ArtifactRef[]) => {
      values[0]!.byteLength = 17n * 1024n * 1024n;
    }],
    ['spool total', (values: agentV1Artifact.ArtifactRef[]) => {
      values[0]!.byteLength = 9n * 1024n * 1024n;
      values[1]!.byteLength = 9n * 1024n * 1024n;
    }],
    ['oversized text', (values: agentV1Artifact.ArtifactRef[]) => {
      values[0]!.kind = 'x'.repeat(513);
    }],
  ])('rejects artifact manifest with %s', (_name, mutate) => {
    const artifacts = preparedArtifacts();
    mutate(artifacts);
    expect(() => validatePreparedFacts(
      prepared({ validatedArtifacts: artifacts }),
      expectation(),
    )).toThrow(expect.objectContaining({
      code: 'prepared_facts_mismatch',
    }));
  });
});
