#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeRuntimeBuildId,
  currentRuntimeTarget,
  runtimePlatform,
  sha256,
  sha256File,
} from './lib/rust-agent-package-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const requestedTarget = argument('--target') ?? currentRuntimeTarget();
const platform = runtimePlatform(requestedTarget);
const executableSuffix = platform.operatingSystem === 'windows' ? '.exe' : '';
const maximumBinaryBytes = 256 * 1024 * 1024;
const releaseDirectory = await locateReleaseDirectory(requestedTarget);
const destinationRoot = resolve(root, 'dist/native-agent-runtime');
const destination = join(destinationRoot, requestedTarget);
const staging = join(destinationRoot, `.stage-${requestedTarget}-${process.pid}`);
const anchorPath = resolve(
  root,
  'dist/apps/electron/native-agent-runtime-integrity.json',
);

if (!skipBuild) {
  run(cargo(), [
    'build',
    '--manifest-path',
    'native/agent-runtime/Cargo.toml',
    '-p',
    'agent-runner',
    '-p',
    'agentd-supervisor',
    '-p',
    'agent-host-bridge-napi',
    '--release',
    '--locked',
    '--target',
    requestedTarget,
  ]);
}

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const binaries = [];
for (const artifact of [
  {
    role: 'hostBridge',
    file: 'agent-host-bridge.node',
    source: addonSource(releaseDirectory, platform.operatingSystem),
    executable: false,
  },
  {
    role: 'runner',
    file: `agent-runner${executableSuffix}`,
    source: join(releaseDirectory, `agent-runner${executableSuffix}`),
    executable: true,
  },
  {
    role: 'supervisor',
    file: `agentd-supervisor${executableSuffix}`,
    source: join(releaseDirectory, `agentd-supervisor${executableSuffix}`),
    executable: true,
  },
]) {
  const { role, file, source, executable } = artifact;
  const target = join(staging, file);
  const sourceStat = await lstat(source);
  if (
    sourceStat.isSymbolicLink()
    || !sourceStat.isFile()
    || sourceStat.size <= 0
    || sourceStat.size > maximumBinaryBytes
  ) {
    throw new Error(`unsafe or missing release artifact: ${source}`);
  }
  await copyFile(source, target);
  if (platform.operatingSystem !== 'windows') {
    await chmod(target, executable ? 0o755 : 0o644);
  }
  binaries.push({
    role,
    file,
    bytes: sourceStat.size,
    sha256: await sha256File(target),
  });
}
binaries.sort((left, right) => left.role.localeCompare(right.role));

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sourceCommit = process.env.MCP_AGENT_SOURCE_COMMIT ?? gitSourceCommit();
if (!/^[0-9a-f]{7,64}$/.test(sourceCommit)) {
  throw new Error('Rust package source commit is invalid');
}
const manifestInput = {
  packageVersion: String(packageJson.version),
  sourceCommit,
  targetTriple: requestedTarget,
  operatingSystem: platform.operatingSystem,
  architecture: platform.architecture,
  contractVersion: '1.0.0',
  contractSchemaVersion: 1,
  binaries,
};
const manifest = {
  schemaVersion: 1,
  packageVersion: manifestInput.packageVersion,
  buildId: computeRuntimeBuildId(manifestInput),
  sourceCommit: manifestInput.sourceCommit,
  targetTriple: manifestInput.targetTriple,
  operatingSystem: manifestInput.operatingSystem,
  architecture: manifestInput.architecture,
  contractVersion: manifestInput.contractVersion,
  contractSchemaVersion: manifestInput.contractSchemaVersion,
  binaries,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const manifestSha256 = sha256(manifestBytes);
await writeFile(join(staging, 'manifest.json'), manifestBytes, { flag: 'wx' });
await writeFile(
  join(staging, 'manifest.sha256'),
  `${manifestSha256}  manifest.json\n`,
  { flag: 'wx' },
);
await verifyPackage(staging, manifest, manifestSha256);

await mkdir(destinationRoot, { recursive: true });
await rm(destination, { recursive: true, force: true });
await rename(staging, destination);
await verifyPackage(destination, manifest, manifestSha256);

const anchor = {
  schemaVersion: 1,
  targetTriple: requestedTarget,
  buildId: manifest.buildId,
  manifestSha256,
};
await mkdir(dirname(anchorPath), { recursive: true });
await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`);
console.log(
  `Rust agent package ready: ${requestedTarget} build=${manifest.buildId} manifest=${manifestSha256}`,
);

async function locateReleaseDirectory(target) {
  const targetSpecific = resolve(
    root,
    `native/agent-runtime/target/${target}/release`,
  );
  if (!skipBuild) return targetSpecific;
  try {
    const value = await lstat(targetSpecific);
    if (value.isDirectory() && !value.isSymbolicLink()) return targetSpecific;
  } catch {}
  return resolve(root, 'native/agent-runtime/target/release');
}

function addonSource(releaseDirectory, operatingSystem) {
  const file = {
    linux: 'libagent_host_bridge_napi.so',
    macos: 'libagent_host_bridge_napi.dylib',
    windows: 'agent_host_bridge_napi.dll',
  }[operatingSystem];
  if (!file) throw new Error(`unsupported addon platform: ${operatingSystem}`);
  return join(releaseDirectory, file);
}

async function verifyPackage(directory, expectedManifest, expectedDigest) {
  const manifestPath = join(directory, 'manifest.json');
  const bytes = await readFile(manifestPath);
  if (sha256(bytes) !== expectedDigest) throw new Error('manifest digest mismatch');
  const sidecar = await readFile(join(directory, 'manifest.sha256'), 'utf8');
  if (sidecar !== `${expectedDigest}  manifest.json\n`) {
    throw new Error('manifest sidecar mismatch');
  }
  const parsed = JSON.parse(bytes.toString('utf8'));
  const { buildId: _buildId, schemaVersion: _schemaVersion, ...input } = parsed;
  if (
    parsed.buildId !== computeRuntimeBuildId(input)
    || parsed.buildId !== expectedManifest.buildId
  ) throw new Error('runtime build ID mismatch');
  for (const binary of parsed.binaries) {
    const path = join(directory, binary.file);
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.size !== binary.bytes
      || await sha256File(path) !== binary.sha256
    ) throw new Error(`runtime ${binary.role} failed staged verification`);
  }
}

function gitSourceCommit() {
  const result = spawnSync(
    'git',
    ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD'],
    { cwd: root, encoding: 'utf8', shell: false },
  );
  const commit = result.stdout?.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('cannot determine source commit for Rust package');
  }
  return commit;
}

function cargo() {
  return process.env.CARGO ?? 'cargo';
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${command}`);
  }
}

function argument(name) {
  const prefix = `${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
