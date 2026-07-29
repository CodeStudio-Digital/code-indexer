import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRuntimePackageManifest,
  currentRuntimeTarget,
  parseRuntimePackageManifest,
  serializeRuntimePackageManifest,
  sha256Hex,
  verifyRuntimePackage,
  type RuntimePackageAnchor,
  type RuntimePackageBinary,
} from '../packaging/index.js';

describe('native runtime package integrity', () => {
  it('binds every native artifact, provenance and trusted manifest anchor', async () => {
    await withPackage(async ({ directory, anchor, manifest }) => {
      const verified = await verifyRuntimePackage(directory, anchor);
      expect(verified.manifest).toEqual(manifest);
      expect(verified.binaries.runner.absolutePath).toBe(
        join(directory, 'agent-runner.exe'),
      );
      expect(verified.binaries.supervisor.absolutePath).toBe(
        join(directory, 'agentd-supervisor.exe'),
      );
      expect(verified.binaries.hostBridge.absolutePath).toBe(
        join(directory, 'agent-host-bridge.node'),
      );
      expect(manifest.buildId).toMatch(/^runtime-v1-[0-9a-f]{64}$/);
      expect(Object.isFrozen(verified.manifest)).toBe(true);
      expect(Object.isFrozen(verified.manifest.binaries)).toBe(true);
    });
  });

  it('rejects binary tampering even when size is unchanged', async () => {
    await withPackage(async ({ directory, anchor }) => {
      await writeFile(join(directory, 'agent-runner.exe'), Buffer.from('RUNNER'));
      await expect(verifyRuntimePackage(directory, anchor)).rejects.toThrow(
        'runtime runner digest is invalid',
      );
    });
  });

  it('rejects a rewritten manifest and sidecar without the embedded anchor', async () => {
    await withPackage(async ({ directory, anchor, manifest }) => {
      const rewrittenManifest = createRuntimePackageManifest({
        packageVersion: '9.9.9',
        sourceCommit: manifest.sourceCommit,
        targetTriple: manifest.targetTriple,
        operatingSystem: manifest.operatingSystem,
        architecture: manifest.architecture,
        contractVersion: manifest.contractVersion,
        contractSchemaVersion: manifest.contractSchemaVersion,
        binaries: manifest.binaries,
      });
      const rewritten = serializeRuntimePackageManifest(rewrittenManifest);
      const digest = sha256Hex(rewritten);
      await writeFile(join(directory, 'manifest.json'), rewritten);
      await writeFile(
        join(directory, 'manifest.sha256'),
        `${digest}  manifest.json\n`,
      );
      await expect(verifyRuntimePackage(directory, anchor)).rejects.toThrow(
        'runtime package manifest digest is untrusted',
      );
    });
  });

  it('rejects a manifest whose build ID does not bind its contents', async () => {
    await withPackage(async ({ manifest }) => {
      const encoded = Buffer.from(JSON.stringify({
        ...manifest,
        buildId: `runtime-v1-${'0'.repeat(64)}`,
      }));
      expect(() => parseRuntimePackageManifest(encoded)).toThrow(
        'runtime package build ID is invalid',
      );
    });
  });

  it('maps only the six supported native targets', () => {
    expect(currentRuntimeTarget('win32', 'x64')).toBe(
      'x86_64-pc-windows-msvc',
    );
    expect(currentRuntimeTarget('darwin', 'arm64')).toBe(
      'aarch64-apple-darwin',
    );
    expect(() => currentRuntimeTarget('freebsd', 'x64')).toThrow(
      'unsupported runtime target',
    );
  });
});

async function withPackage(
  run: (fixture: {
    directory: string;
    anchor: RuntimePackageAnchor;
    manifest: ReturnType<typeof createRuntimePackageManifest>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codestudio-runtime-package-'));
  const directory = join(root, 'package');
  await mkdir(directory);
  try {
    const runner = Buffer.from('runner');
    const supervisor = Buffer.from('supervisor');
    const hostBridge = Buffer.from('host-bridge');
    await writeFile(join(directory, 'agent-runner.exe'), runner);
    await writeFile(join(directory, 'agentd-supervisor.exe'), supervisor);
    await writeFile(join(directory, 'agent-host-bridge.node'), hostBridge);
    const binaries: readonly RuntimePackageBinary[] = [
      {
        role: 'hostBridge',
        file: 'agent-host-bridge.node',
        bytes: hostBridge.byteLength,
        sha256: sha256Hex(hostBridge),
      },
      {
        role: 'runner',
        file: 'agent-runner.exe',
        bytes: runner.byteLength,
        sha256: sha256Hex(runner),
      },
      {
        role: 'supervisor',
        file: 'agentd-supervisor.exe',
        bytes: supervisor.byteLength,
        sha256: sha256Hex(supervisor),
      },
    ];
    const manifest = createRuntimePackageManifest({
      packageVersion: '3.15.1',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      targetTriple: 'x86_64-pc-windows-msvc',
      operatingSystem: 'windows',
      architecture: 'x86_64',
      contractVersion: '1.0.0',
      contractSchemaVersion: 1,
      binaries,
    });
    const bytes = serializeRuntimePackageManifest(manifest);
    const manifestSha256 = sha256Hex(bytes);
    await writeFile(join(directory, 'manifest.json'), bytes);
    await writeFile(
      join(directory, 'manifest.sha256'),
      `${manifestSha256}  manifest.json\n`,
    );
    const anchor: RuntimePackageAnchor = {
      schemaVersion: 1,
      targetTriple: manifest.targetTriple,
      buildId: manifest.buildId,
      manifestSha256,
    };
    await run({ directory, anchor, manifest });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
