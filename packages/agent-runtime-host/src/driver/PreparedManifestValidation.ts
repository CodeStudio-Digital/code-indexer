import { timingSafeEqual } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';

const MAX_TEXT_BYTES = 512;
const MAX_UINT64 = (1n << 64n) - 1n;

export function validateSnapshotManifest(
  actual: readonly agentV1Common.SnapshotRef[],
  expected: readonly agentV1Common.SnapshotRef[],
): void {
  const actualMap = snapshotMap(actual);
  const expectedMap = snapshotMap(expected);
  if (!sameMap(actualMap, expectedMap)) {
    throw mismatch('AttemptPrepared loaded snapshots mismatch expectation');
  }
}

export function validateArtifactManifest(
  actual: readonly agentV1Artifact.ArtifactRef[],
  expected: readonly agentV1Artifact.ArtifactRef[],
  ownerSessionId: string,
  budget: agentV1Common.ResourceBudget,
): void {
  const actualMap = artifactMap(actual, ownerSessionId, budget);
  const expectedMap = artifactMap(expected, ownerSessionId, budget);
  if (!sameMap(actualMap, expectedMap)) {
    throw mismatch('AttemptPrepared validated artifacts mismatch expectation');
  }
}

function snapshotMap(
  values: readonly agentV1Common.SnapshotRef[],
): Map<string, Uint8Array> {
  const output = new Map<string, Uint8Array>();
  for (const value of values) {
    if (
      !validText(value.ref)
      || !validText(value.origin)
      || !validText(value.schemaId)
      || value.version <= 0n
      || value.version > MAX_UINT64
      || value.schemaVersion <= 0
      || value.contentSha256.byteLength !== 32
      || output.has(value.ref)
    ) {
      throw mismatch('AttemptPrepared contains an invalid snapshot manifest');
    }
    output.set(
      value.ref,
      toBinary(agentV1Common.SnapshotRefSchema, value),
    );
  }
  return output;
}

function artifactMap(
  values: readonly agentV1Artifact.ArtifactRef[],
  ownerSessionId: string,
  budget: agentV1Common.ResourceBudget,
): Map<string, Uint8Array> {
  const output = new Map<string, Uint8Array>();
  let totalBytes = 0n;
  for (const value of values) {
    totalBytes += value.byteLength;
    if (
      !validText(value.artifactId)
      || !validText(value.kind)
      || !validText(value.mediaType)
      || !validText(value.redactionPolicyVersion)
      || !validText(value.ownerSessionId)
      || value.ownerSessionId !== ownerSessionId
      || value.contentSha256.byteLength !== 32
      || value.byteLength <= 0n
      || value.byteLength > MAX_UINT64
      || value.byteLength > budget.maxArtifactBytes
      || totalBytes > budget.maxSpoolBytes
      || !validCompression(value.compression)
      || !validPrivacy(value.privacyClass)
      || output.has(value.artifactId)
    ) {
      throw mismatch('AttemptPrepared contains an invalid artifact manifest');
    }
    output.set(
      value.artifactId,
      toBinary(agentV1Artifact.ArtifactRefSchema, value),
    );
  }
  return output;
}

function sameMap(
  left: ReadonlyMap<string, Uint8Array>,
  right: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, leftValue] of left) {
    const rightValue = right.get(key);
    if (
      !rightValue
      || leftValue.byteLength !== rightValue.byteLength
      || !timingSafeEqual(leftValue, rightValue)
    ) return false;
  }
  return true;
}

function validText(value: string): boolean {
  return (
    value.trim().length > 0
    && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES
  );
}

function validCompression(
  value: agentV1Artifact.ArtifactCompression,
): boolean {
  return (
    value === agentV1Artifact.ArtifactCompression.NONE
    || value === agentV1Artifact.ArtifactCompression.GZIP
    || value === agentV1Artifact.ArtifactCompression.ZSTD
  );
}

function validPrivacy(
  value: agentV1Artifact.ArtifactPrivacyClass,
): boolean {
  return (
    value === agentV1Artifact.ArtifactPrivacyClass.PUBLIC
    || value === agentV1Artifact.ArtifactPrivacyClass.INTERNAL
    || value === agentV1Artifact.ArtifactPrivacyClass.CONFIDENTIAL
    || value === agentV1Artifact.ArtifactPrivacyClass.RESTRICTED
  );
}

function mismatch(message: string): HostLifecycleDriverError {
  return new HostLifecycleDriverError('prepared_facts_mismatch', message);
}
