import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import type {
  HostHydrationSource,
} from '../ipc/HostDataHydration.js';
import { identity } from './attempt-channel-support.js';

export interface HydrationSourceFixture {
  readonly source: HostHydrationSource;
  readonly expectedSnapshots: readonly agentV1Common.SnapshotRef[];
  readonly expectedArtifacts: readonly agentV1Artifact.ArtifactRef[];
  readonly state: {
    readonly returnedChunks: Uint8Array[];
    readonly closeCauses: unknown[];
  };
}

export function hydrationSourceFixture(
  snapshotBytes = Buffer.from('abcdefghij'),
  artifactBytes = Buffer.from('xyz'),
): HydrationSourceFixture {
  const snapshot = create(agentV1Common.SnapshotRefSchema, {
    ref: 'snapshot:policy',
    version: 1n,
    contentSha256: sha256(snapshotBytes),
    origin: 'session-store',
    schemaId: 'test.snapshot',
    schemaVersion: 1,
  });
  const artifact = create(agentV1Artifact.ArtifactRefSchema, {
    artifactId: 'artifact:task',
    kind: 'task_input',
    contentSha256: sha256(artifactBytes),
    mediaType: 'application/octet-stream',
    byteLength: BigInt(artifactBytes.byteLength),
    compression: agentV1Artifact.ArtifactCompression.NONE,
    privacyClass: agentV1Artifact.ArtifactPrivacyClass.CONFIDENTIAL,
    redactionPolicyVersion: 'v1',
    ownerSessionId: identity().sessionId,
  });
  const bodies = [snapshotBytes, artifactBytes];
  const state = {
    returnedChunks: [] as Uint8Array[],
    closeCauses: [] as unknown[],
  };
  const source: HostHydrationSource = {
    items: [
      {
        reference: { case: 'snapshot', value: snapshot },
        byteLength: BigInt(snapshotBytes.byteLength),
      },
      {
        reference: { case: 'artifact', value: artifact },
        byteLength: BigInt(artifactBytes.byteLength),
      },
    ],
    async readExact(ordinal, offset, length, signal) {
      signal?.throwIfAborted();
      const selected = bodies[ordinal]!;
      const chunk = Uint8Array.from(
        selected.subarray(Number(offset), Number(offset) + length),
      );
      state.returnedChunks.push(chunk);
      return chunk;
    },
    close(cause) {
      state.closeCauses.push(cause);
    },
  };
  return {
    source,
    expectedSnapshots: [snapshot],
    expectedArtifacts: [artifact],
    state,
  };
}

function sha256(value: Uint8Array): Uint8Array {
  return createHash('sha256').update(value).digest();
}
