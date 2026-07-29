import { createHash } from 'node:crypto';
import type {
  RuntimePackageManifestInput,
} from './RuntimePackageTypes.js';

const BUILD_ID_DOMAIN = Buffer.from(
  'codestudio.agent.runtime-package-build.v1\0',
  'utf8',
);

export function sha256Bytes(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

export function sha256Hex(bytes: Uint8Array): string {
  return sha256Bytes(bytes).toString('hex');
}

export function computeRuntimeBuildId(
  input: RuntimePackageManifestInput,
): string {
  const hash = createHash('sha256').update(BUILD_ID_DOMAIN);
  updateText(hash, input.packageVersion);
  updateText(hash, input.sourceCommit);
  updateText(hash, input.targetTriple);
  updateText(hash, input.operatingSystem);
  updateText(hash, input.architecture);
  updateText(hash, input.contractVersion);
  hash.update(uint64(input.contractSchemaVersion));
  for (const binary of [...input.binaries].sort(
    (left, right) => left.role.localeCompare(right.role),
  )) {
    updateText(hash, binary.role);
    updateText(hash, binary.file);
    hash.update(uint64(binary.bytes));
    hash.update(Buffer.from(binary.sha256, 'hex'));
  }
  return `runtime-v1-${hash.digest('hex')}`;
}

function updateText(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function uint64(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}
