import {
  computeRuntimeBuildId,
} from './RuntimePackageHash.js';
import {
  RUNTIME_PACKAGE_SCHEMA_VERSION,
  RUNTIME_PACKAGE_ANCHOR_SCHEMA_VERSION,
  type RuntimePackageBinary,
  type RuntimePackageAnchor,
  type RuntimePackageManifest,
  type RuntimePackageManifestInput,
} from './RuntimePackageTypes.js';

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT = /^[0-9a-f]{7,64}$/;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MANIFEST_KEYS = [
  'architecture',
  'binaries',
  'buildId',
  'contractSchemaVersion',
  'contractVersion',
  'operatingSystem',
  'packageVersion',
  'schemaVersion',
  'sourceCommit',
  'targetTriple',
] as const;
const BINARY_KEYS = ['bytes', 'file', 'role', 'sha256'] as const;
const ANCHOR_KEYS = [
  'buildId',
  'manifestSha256',
  'schemaVersion',
  'targetTriple',
] as const;

export function createRuntimePackageManifest(
  input: RuntimePackageManifestInput,
): RuntimePackageManifest {
  const normalized: RuntimePackageManifestInput = {
    ...input,
    binaries: [...input.binaries].sort(
      (left, right) => left.role.localeCompare(right.role),
    ),
  };
  const manifest: RuntimePackageManifest = {
    schemaVersion: RUNTIME_PACKAGE_SCHEMA_VERSION,
    packageVersion: normalized.packageVersion,
    buildId: computeRuntimeBuildId(normalized),
    sourceCommit: normalized.sourceCommit,
    targetTriple: normalized.targetTriple,
    operatingSystem: normalized.operatingSystem,
    architecture: normalized.architecture,
    contractVersion: normalized.contractVersion,
    contractSchemaVersion: normalized.contractSchemaVersion,
    binaries: normalized.binaries,
  };
  assertRuntimePackageManifest(manifest);
  return freezeManifest(manifest);
}

export function serializeRuntimePackageManifest(
  manifest: RuntimePackageManifest,
): Buffer {
  assertRuntimePackageManifest(manifest);
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function parseRuntimePackageManifest(
  bytes: Uint8Array,
): RuntimePackageManifest {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    throw new RangeError('runtime package manifest size is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new TypeError('runtime package manifest JSON is invalid');
  }
  assertRuntimePackageManifest(parsed);
  return freezeManifest(parsed);
}

export function parseRuntimePackageAnchor(
  bytes: Uint8Array,
): RuntimePackageAnchor {
  if (bytes.byteLength === 0 || bytes.byteLength > 4096) {
    throw new RangeError('runtime package anchor size is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new TypeError('runtime package anchor JSON is invalid');
  }
  if (
    !plainObject(parsed)
    || !exactKeys(parsed, ANCHOR_KEYS)
    || parsed.schemaVersion !== RUNTIME_PACKAGE_ANCHOR_SCHEMA_VERSION
    || !boundedText(parsed.targetTriple)
    || !boundedText(parsed.buildId)
    || typeof parsed.manifestSha256 !== 'string'
    || !SHA256.test(parsed.manifestSha256)
  ) throw new TypeError('runtime package anchor is invalid');
  return Object.freeze({
    ...(parsed as unknown as RuntimePackageAnchor),
  });
}

export function assertRuntimePackageManifest(
  value: unknown,
): asserts value is RuntimePackageManifest {
  if (!plainObject(value) || !exactKeys(value, MANIFEST_KEYS)) {
    throw new TypeError('runtime package manifest shape is invalid');
  }
  const manifest = value as unknown as RuntimePackageManifest;
  if (
    manifest.schemaVersion !== RUNTIME_PACKAGE_SCHEMA_VERSION
    || !boundedText(manifest.packageVersion)
    || !SOURCE_COMMIT.test(manifest.sourceCommit)
    || !boundedText(manifest.targetTriple)
    || !boundedText(manifest.contractVersion)
    || !Number.isSafeInteger(manifest.contractSchemaVersion)
    || manifest.contractSchemaVersion <= 0
    || !validPlatform(manifest)
    || !Array.isArray(manifest.binaries)
    || manifest.binaries.length !== 3
  ) {
    throw new TypeError('runtime package manifest fields are invalid');
  }
  assertBinaries(manifest.binaries, manifest.operatingSystem);
  const { buildId: _buildId, schemaVersion: _schemaVersion, ...input } = manifest;
  if (manifest.buildId !== computeRuntimeBuildId(input)) {
    throw new TypeError('runtime package build ID is invalid');
  }
}

function assertBinaries(
  binaries: readonly RuntimePackageBinary[],
  operatingSystem: RuntimePackageManifest['operatingSystem'],
): void {
  const expected = operatingSystem === 'windows'
    ? {
      hostBridge: 'agent-host-bridge.node',
      runner: 'agent-runner.exe',
      supervisor: 'agentd-supervisor.exe',
    }
    : {
      hostBridge: 'agent-host-bridge.node',
      runner: 'agent-runner',
      supervisor: 'agentd-supervisor',
    };
  const roles = new Set<string>();
  for (const binary of binaries) {
    if (
      !plainObject(binary)
      || !exactKeys(binary, BINARY_KEYS)
      || !['hostBridge', 'runner', 'supervisor'].includes(binary.role)
      || roles.has(binary.role)
      || binary.file !== expected[binary.role]
      || !Number.isSafeInteger(binary.bytes)
      || binary.bytes <= 0
      || binary.bytes > MAX_BINARY_BYTES
      || !SHA256.test(binary.sha256)
    ) throw new TypeError('runtime package binary entry is invalid');
    roles.add(binary.role);
  }
  if (
    !roles.has('hostBridge')
    || !roles.has('runner')
    || !roles.has('supervisor')
  ) {
    throw new TypeError('runtime package binary roles are incomplete');
  }
}

function validPlatform(manifest: RuntimePackageManifest): boolean {
  const expected = {
    'linux:aarch64': 'aarch64-unknown-linux-gnu',
    'linux:x86_64': 'x86_64-unknown-linux-gnu',
    'macos:aarch64': 'aarch64-apple-darwin',
    'macos:x86_64': 'x86_64-apple-darwin',
    'windows:aarch64': 'aarch64-pc-windows-msvc',
    'windows:x86_64': 'x86_64-pc-windows-msvc',
  }[`${manifest.operatingSystem}:${manifest.architecture}`];
  return expected === manifest.targetTriple;
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join('\0')
    === [...expected].sort().join('\0');
}

function freezeManifest(
  manifest: RuntimePackageManifest,
): RuntimePackageManifest {
  const binaries = Object.freeze(
    manifest.binaries.map((binary) => Object.freeze({ ...binary })),
  );
  return Object.freeze({ ...manifest, binaries });
}
