import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destroySandboxInternal } from '../manager/destroy-sandbox.js';
import { SandboxRegistry } from '../manager/state/registry.js';
import type { ISandboxDriver } from '../ports/sandbox-driver.js';
import type { Sandbox } from '../types.js';
import {
  deleteArchive,
  loadArchive,
  resolveSandboxArchivePath,
  saveArchive,
  setSandboxArchiveBundleResolver,
} from '../archive.js';

let root = '';
let sessionRoot = '';
const sessionId = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbox-bundle-archive-'));
  sessionRoot = join(root, 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  setSandboxArchiveBundleResolver({
    resolveBundle: async (requestedId) => {
      if (requestedId !== sessionId) return null;
      return {
        sessionRoot,
        bundlePath: join(sessionRoot, sessionId),
      };
    },
  });
  mkdirSync(join(sessionRoot, sessionId), { recursive: true });
});

afterEach(() => {
  setSandboxArchiveBundleResolver(null);
  rmSync(root, { recursive: true, force: true });
});

describe('bundle-local sandbox archive', () => {
  it('atomically saves, replaces, loads and deletes the canonical tar', async () => {
    const expectedPath = join(
      sessionRoot,
      sessionId,
      'checkpoints',
      'sandbox',
      'workdir.tar',
    );
    await expect(resolveSandboxArchivePath(sessionId)).resolves.toBe(expectedPath);
    await expect(loadArchive(sessionId)).resolves.toBeNull();

    await saveArchive(sessionId, Buffer.from('first'));
    expect(readFileSync(expectedPath, 'utf8')).toBe('first');
    await saveArchive(sessionId, Buffer.from('second'));
    await expect(loadArchive(sessionId)).resolves.toEqual(Buffer.from('second'));

    await deleteArchive(sessionId);
    await expect(loadArchive(sessionId)).resolves.toBeNull();
  });

  it('fails closed when the resolver is unwired or the bundle is unknown', async () => {
    setSandboxArchiveBundleResolver(null);
    await expect(loadArchive(sessionId)).rejects.toThrow(
      'filesystem authority is not wired',
    );

    setSandboxArchiveBundleResolver({
      resolveBundle: async () => null,
    });
    await expect(saveArchive(sessionId, Buffer.from('x'))).rejects.toThrow(
      'No filesystem session bundle exists',
    );
  });

  it('rejects a resolver result that escapes its declared session root', async () => {
    setSandboxArchiveBundleResolver({
      resolveBundle: async () => ({
        sessionRoot,
        bundlePath: root,
      }),
    });
    await expect(resolveSandboxArchivePath(sessionId)).rejects.toThrow(
      'Path escapes session root',
    );
  });

  it('keeps a live container intact when its archive authority is unavailable', async () => {
    setSandboxArchiveBundleResolver(null);
    const registry = new SandboxRegistry();
    const sandbox = {
      id: sessionId,
      containerId: 'container-1',
      hostPort: 47_001,
      workdir: '/app',
      status: 'ready',
    } as Sandbox;
    registry.primary.set(sessionId, sandbox);
    const destroy = vi.fn(async () => undefined);
    const driver = {
      exportWorkdir: async () => Buffer.from('workdir'),
      destroy,
    } as unknown as ISandboxDriver;

    await expect(destroySandboxInternal(sessionId, 'idle-ttl', {
      driver,
      registry,
      allocator: { release: vi.fn() },
      store: null,
      emit: vi.fn(),
    })).rejects.toThrow('failed closed');
    expect(destroy).not.toHaveBeenCalled();
    expect(registry.getPrimary(sessionId)).toBe(sandbox);
    expect(sandbox.status).toBe('ready');
  });

  it('allows explicit session deletion to destroy without writing a redundant tar', async () => {
    setSandboxArchiveBundleResolver(null);
    const registry = new SandboxRegistry();
    registry.primary.set(sessionId, {
      id: sessionId,
      containerId: 'container-2',
      hostPort: 47_002,
      workdir: '/app',
      status: 'ready',
    } as Sandbox);
    const destroy = vi.fn(async () => undefined);
    const exportWorkdir = vi.fn(async () => Buffer.from('unused'));
    const driver = {
      exportWorkdir,
      destroy,
    } as unknown as ISandboxDriver;

    await destroySandboxInternal(sessionId, 'session-deleted', {
      driver,
      registry,
      allocator: { release: vi.fn() },
      store: null,
      emit: vi.fn(),
    });
    expect(exportWorkdir).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith('container-2');
    expect(registry.getPrimary(sessionId)).toBeUndefined();
  });
});
