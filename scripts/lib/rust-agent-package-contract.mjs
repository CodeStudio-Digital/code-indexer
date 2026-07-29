import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const BUILD_DOMAIN = Buffer.from(
  'codestudio.agent.runtime-package-build.v1\0',
  'utf8',
);

const TARGETS = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({
    operatingSystem: 'macos',
    architecture: 'aarch64',
  }),
  'aarch64-pc-windows-msvc': Object.freeze({
    operatingSystem: 'windows',
    architecture: 'aarch64',
  }),
  'aarch64-unknown-linux-gnu': Object.freeze({
    operatingSystem: 'linux',
    architecture: 'aarch64',
  }),
  'x86_64-apple-darwin': Object.freeze({
    operatingSystem: 'macos',
    architecture: 'x86_64',
  }),
  'x86_64-pc-windows-msvc': Object.freeze({
    operatingSystem: 'windows',
    architecture: 'x86_64',
  }),
  'x86_64-unknown-linux-gnu': Object.freeze({
    operatingSystem: 'linux',
    architecture: 'x86_64',
  }),
});

export function currentRuntimeTarget(
  platform = process.platform,
  architecture = process.arch,
) {
  const target = {
    'darwin:arm64': 'aarch64-apple-darwin',
    'darwin:x64': 'x86_64-apple-darwin',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'win32:arm64': 'aarch64-pc-windows-msvc',
    'win32:x64': 'x86_64-pc-windows-msvc',
  }[`${platform}:${architecture}`];
  if (!target) throw new Error('unsupported native runtime target');
  return target;
}

export function runtimePlatform(target) {
  const value = TARGETS[target];
  if (!value) throw new Error(`unsupported target triple: ${target}`);
  return value;
}

export function computeRuntimeBuildId(input) {
  const hash = createHash('sha256').update(BUILD_DOMAIN);
  for (const value of [
    input.packageVersion,
    input.sourceCommit,
    input.targetTriple,
    input.operatingSystem,
    input.architecture,
    input.contractVersion,
  ]) updateText(hash, value);
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

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

function updateText(hash, value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length).update(bytes);
}

function uint64(value) {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}
