/**
 * spawnSpecFor + binary-asset resolution + registry routing invariants.
 * Pure unit tests — no processes are spawned, no network.
 */
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LSP_SERVER_REGISTRY,
  binaryAssetFor,
  currentTargetKey,
  serverById,
  serverForLanguage,
  spawnSpecFor,
  type LspServerDef,
  type LspTargetKey,
} from '../server-registry.js';

const ALL_TARGETS: LspTargetKey[] = [
  'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64',
];

const npmDef: LspServerDef = {
  id: 'fake-npm',
  label: 'Fake (npm)',
  languages: ['php'],
  install: { kind: 'npm', package: 'fake', version: '1.0.0' },
  entryRelPath: 'node_modules/fake/entry.js',
  args: ['--stdio'],
  sizeLabel: '~1 MB',
};

/** Same asset on every target so the test passes on any host platform. */
function binaryDef(perTarget: Partial<Record<LspTargetKey, { binRelPath?: string }>> = {}): LspServerDef {
  const assets = Object.fromEntries(ALL_TARGETS.map((t) => [t, {
    url: `https://example.invalid/${t}/fake.gz`,
    archive: 'gz' as const,
    ...perTarget[t],
  }]));
  return {
    id: 'fake-bin',
    label: 'Fake (binary)',
    languages: ['rust'],
    install: { kind: 'binary', version: '2.0.0', binRelPath: 'fake-bin', assets },
    args: ['server'],
    sizeLabel: '~1 MB',
  };
}

describe('spawnSpecFor', () => {
  it('npm: node + entry + args, env passthrough, checkPath = entry', () => {
    const spec = spawnSpecFor(
      npmDef,
      join('/base', 'fake-npm@1.0.0'),
      () => ({ command: '/node/bin/node', env: { ELECTRON_RUN_AS_NODE: '1' } }),
      'php',
    );
    const entry = join('/base', 'fake-npm@1.0.0', 'node_modules/fake/entry.js');
    expect(spec.command).toBe('/node/bin/node');
    expect(spec.args).toEqual([entry, '--stdio']);
    expect(spec.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(spec.checkPath).toBe(entry);
  });

  it('binary: direct exec, resolveNode never consulted, no env injection', () => {
    const resolveNode = vi.fn(() => ({ command: 'node' }));
    const spec = spawnSpecFor(binaryDef(), join('/base', 'fake-bin@2.0.0'), resolveNode);
    expect(resolveNode).not.toHaveBeenCalled();
    expect(spec.command).toBe(join('/base', 'fake-bin@2.0.0', 'fake-bin'));
    expect(spec.args).toEqual(['server']);
    expect(spec.env).toBeUndefined();
    expect(spec.checkPath).toBe(spec.command);
  });

  it('binary: per-asset binRelPath override wins over the def default', () => {
    const def = binaryDef({ 'win32-x64': { binRelPath: 'fake-bin.exe' } });
    expect(binaryAssetFor(def, 'win32-x64')?.binRelPath).toBe('fake-bin.exe');
    expect(binaryAssetFor(def, 'linux-x64')?.binRelPath).toBe('fake-bin');
  });
});

describe('currentTargetKey', () => {
  it('maps supported platform/arch pairs and rejects the rest', () => {
    expect(currentTargetKey('win32', 'x64')).toBe('win32-x64');
    expect(currentTargetKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(currentTargetKey('linux', 'ia32' as NodeJS.Architecture)).toBeNull();
  });
});

describe('registry routing', () => {
  it('python primary stays pyright; ruff is a by-id linter complement', () => {
    expect(serverForLanguage('python')?.id).toBe('pyright');
    expect(serverById('ruff')?.role).toBe('linter');
    expect(serverById('ruff')?.args).toEqual(['server']);
  });

  it('rust routes to rust-analyzer', () => {
    expect(serverForLanguage('rust')?.id).toBe('rust-analyzer');
  });

  it('binary catalog entries carry an https asset for every supported target', () => {
    for (const def of LSP_SERVER_REGISTRY) {
      if (def.install.kind !== 'binary') continue;
      for (const target of ALL_TARGETS) {
        const resolved = binaryAssetFor(def, target);
        expect(resolved, `${def.id} missing asset for ${target}`).not.toBeNull();
        expect(resolved!.asset.url).toMatch(/^https:\/\//);
        expect(resolved!.binRelPath.length).toBeGreaterThan(0);
      }
    }
  });
});
