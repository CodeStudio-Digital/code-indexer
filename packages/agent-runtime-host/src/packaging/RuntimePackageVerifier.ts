import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  open,
  readFile,
  realpath,
  lstat,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import {
  parseRuntimePackageAnchor,
  parseRuntimePackageManifest,
} from './RuntimePackageManifest.js';
import {
  sha256Bytes,
} from './RuntimePackageHash.js';
import {
  RUNTIME_PACKAGE_ANCHOR_SCHEMA_VERSION,
  type RuntimeBinaryRole,
  type RuntimePackageAnchor,
  type VerifiedRuntimeBinary,
  type VerifiedRuntimePackage,
} from './RuntimePackageTypes.js';

const SIDECAR = /^([0-9a-f]{64})  manifest\.json\n$/;
const BUFFER_BYTES = 64 * 1024;

export async function verifyRuntimePackage(
  packageDirectory: string,
  anchor: RuntimePackageAnchor,
): Promise<VerifiedRuntimePackage> {
  assertAnchor(anchor);
  const trustedAnchor = Object.freeze({ ...anchor });
  if (!isAbsolute(packageDirectory)) {
    throw new TypeError('runtime package directory must be absolute');
  }
  const canonicalDirectory = await realpath(packageDirectory);
  if (canonicalDirectory !== resolve(packageDirectory)) {
    throw new TypeError('runtime package directory cannot be an alias');
  }
  const directoryStat = await lstat(canonicalDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new TypeError('runtime package root is not a directory');
  }

  const manifestPath = join(canonicalDirectory, 'manifest.json');
  const manifestBytes = await readBoundedRegularFile(manifestPath, 64 * 1024);
  const manifestDigest = sha256Bytes(manifestBytes);
  if (!safeHexEqual(trustedAnchor.manifestSha256, manifestDigest)) {
    throw new TypeError('runtime package manifest digest is untrusted');
  }
  const sidecar = Buffer.from(
    await readBoundedRegularFile(
      join(canonicalDirectory, 'manifest.sha256'),
      256,
    ),
  ).toString('utf8');
  const sidecarDigest = SIDECAR.exec(sidecar)?.[1];
  if (!sidecarDigest || !safeHexEqual(sidecarDigest, manifestDigest)) {
    throw new TypeError('runtime package manifest sidecar is invalid');
  }

  const manifest = parseRuntimePackageManifest(manifestBytes);
  if (
    manifest.targetTriple !== trustedAnchor.targetTriple
    || manifest.buildId !== trustedAnchor.buildId
  ) throw new TypeError('runtime package anchor does not match manifest');

  const verified = {} as Record<RuntimeBinaryRole, VerifiedRuntimeBinary>;
  for (const binary of manifest.binaries) {
    const absolutePath = join(canonicalDirectory, binary.file);
    const digest = await hashRegularFile(
      canonicalDirectory,
      absolutePath,
      binary.bytes,
    );
    if (!safeHexEqual(binary.sha256, digest)) {
      throw new TypeError(`runtime ${binary.role} digest is invalid`);
    }
    verified[binary.role] = Object.freeze({ ...binary, absolutePath });
  }
  return Object.freeze({
    manifest,
    manifestSha256: manifestDigest,
    binaries: Object.freeze(verified),
  });
}

export async function verifyCurrentRuntimePackage(
  resourcesPath: string,
  embeddedAnchor: Uint8Array,
): Promise<VerifiedRuntimePackage> {
  if (!isAbsolute(resourcesPath)) {
    throw new TypeError('Electron resources path must be absolute');
  }
  const anchor = parseRuntimePackageAnchor(embeddedAnchor);
  const expectedTarget = currentRuntimeTarget();
  if (anchor.targetTriple !== expectedTarget) {
    throw new TypeError('embedded runtime package targets another platform');
  }
  return verifyRuntimePackage(
    join(resourcesPath, 'native-agent-runtime', expectedTarget),
    anchor,
  );
}

export function currentRuntimeTarget(
  platform = process.platform,
  architecture = process.arch,
): string {
  const key = `${platform}:${architecture}`;
  const target = {
    'darwin:arm64': 'aarch64-apple-darwin',
    'darwin:x64': 'x86_64-apple-darwin',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'win32:arm64': 'aarch64-pc-windows-msvc',
    'win32:x64': 'x86_64-pc-windows-msvc',
  }[key];
  if (!target) throw new TypeError(`unsupported runtime target: ${key}`);
  return target;
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    const linked = await lstat(path);
    if (
      !opened.isFile()
      || linked.isSymbolicLink()
      || opened.size <= 0
      || opened.size > maximumBytes
      || !sameFile(opened, linked)
    ) throw new TypeError('runtime package control file is unsafe');
    const bytes = await readFile(handle);
    const after = await lstat(path);
    if (bytes.byteLength !== opened.size || !sameFile(opened, after)) {
      throw new TypeError('runtime package control file changed while reading');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(
  packageRoot: string,
  path: string,
  expectedBytes: number,
): Promise<Buffer> {
  if (resolve(packageRoot, path) !== path) {
    throw new TypeError('runtime binary escapes package root');
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    const linked = await lstat(path);
    if (
      !opened.isFile()
      || linked.isSymbolicLink()
      || opened.size !== expectedBytes
      || !sameFile(opened, linked)
    ) throw new TypeError('runtime binary identity is unsafe');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(buffer.byteLength, expectedBytes - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) {
        throw new TypeError('runtime binary ended during verification');
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await lstat(path);
    if (!sameFile(opened, after) || after.size !== expectedBytes) {
      throw new TypeError('runtime binary changed during verification');
    }
    return hash.digest();
  } finally {
    await handle.close();
  }
}

function assertAnchor(anchor: RuntimePackageAnchor): void {
  if (
    anchor.schemaVersion !== RUNTIME_PACKAGE_ANCHOR_SCHEMA_VERSION
    || !anchor.targetTriple
    || !anchor.buildId
    || !/^[0-9a-f]{64}$/.test(anchor.manifestSha256)
  ) throw new TypeError('runtime package anchor is invalid');
}

function safeHexEqual(expectedHex: string, actual: Uint8Array): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.byteLength === actual.byteLength
    && timingSafeEqual(expected, actual);
}

function sameFile(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
