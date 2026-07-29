/**
 * Regression — deleting a folder on a remote host just failed.
 *
 * SFTP has no recursive remove: `rmdir` errors ("failure") on any directory
 * that still has entries, so the old one-shot `sftp.rmdir(path)` only ever
 * worked on an EMPTY folder. Every real directory delete errored out.
 *
 * `remove` now walks the tree itself, unlinking on the way down and rmdir-ing
 * on the way back up. The order is the part that matters and is pinned here: a
 * parent removed before its children would fail exactly the same way.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SftpManager } from '../ssh-sftp.js';
import type { SshConnectionManager } from '../ssh-connection-manager.js';

const spec = {
  hostId: 'saved:project:1',
  host: 'example.com',
  username: 'root',
  auth: { method: 'agent' as const },
};

interface FakeNode {
  type: 'file' | 'dir' | 'symlink';
  children?: Record<string, FakeNode>;
}

/** Build an ssh2-shaped SFTP double over an in-memory tree, recording the call order. */
function fakeSftp(tree: Record<string, FakeNode>) {
  const calls: string[] = [];

  const lookup = (p: string): FakeNode | undefined => {
    const parts = p.split('/').filter(Boolean);
    let node: FakeNode | undefined = { type: 'dir', children: tree };
    for (const part of parts) {
      node = node?.children?.[part];
      if (!node) return undefined;
    }
    return node;
  };

  const attrs = (n: FakeNode) => ({
    isDirectory: () => n.type === 'dir',
    isSymbolicLink: () => n.type === 'symlink',
    isFile: () => n.type === 'file',
    size: 0,
    mtime: 0,
    mode: 0,
    uid: 0,
    gid: 0,
  });

  const sftp = new EventEmitter() as EventEmitter & Record<string, unknown>;
  sftp.readdir = vi.fn((p: string, cb: (e: Error | null, l?: unknown[]) => void) => {
    const node = lookup(p);
    if (!node?.children) return cb(new Error(`not a directory: ${p}`));
    cb(
      null,
      Object.entries(node.children).map(([filename, n]) => ({ filename, attrs: attrs(n) })),
    );
  });
  sftp.unlink = vi.fn((p: string, cb: (e?: Error | null) => void) => {
    calls.push(`unlink ${p}`);
    cb(null);
  });
  sftp.rmdir = vi.fn((p: string, cb: (e?: Error | null) => void) => {
    const node = lookup(p);
    // Faithful to real SFTP: a non-empty directory REFUSES to go.
    if (node?.children && Object.keys(node.children).length > 0) {
      // Only fail if the children haven't been removed from the model yet.
      const stillThere = Object.keys(node.children).some((c) => !calls.includes(`unlink ${p}/${c}`) && !calls.includes(`rmdir ${p}/${c}`));
      if (stillThere) return cb(new Error('failure: directory not empty'));
    }
    calls.push(`rmdir ${p}`);
    cb(null);
  });
  sftp.end = vi.fn();
  return { sftp, calls };
}

function managerFor(sftp: unknown): SshConnectionManager {
  const client = new EventEmitter() as EventEmitter & { sftp: ReturnType<typeof vi.fn> };
  client.sftp = vi.fn((done: (e: Error | undefined, ch?: unknown) => void) => done(undefined, sftp));
  return { acquire: vi.fn().mockResolvedValue(client), release: vi.fn() } as unknown as SshConnectionManager;
}

describe('SftpManager.remove', () => {
  it('unlinks a plain file without touching readdir', async () => {
    const { sftp, calls } = fakeSftp({ srv: { type: 'dir', children: { 'a.txt': { type: 'file' } } } });
    const svc = new SftpManager(managerFor(sftp));
    await svc.remove(spec, '/srv/a.txt', false);
    expect(calls).toEqual(['unlink /srv/a.txt']);
    expect(sftp.readdir).not.toHaveBeenCalled();
  });

  it('deletes a NON-EMPTY directory — the case that used to just fail', async () => {
    const { sftp, calls } = fakeSftp({
      srv: {
        type: 'dir',
        children: {
          app: {
            type: 'dir',
            children: {
              'index.js': { type: 'file' },
              logs: { type: 'dir', children: { 'a.log': { type: 'file' } } },
            },
          },
        },
      },
    });
    const svc = new SftpManager(managerFor(sftp));
    await svc.remove(spec, '/srv/app', true);

    // Children before parents, at every level.
    expect(calls).toContain('unlink /srv/app/index.js');
    expect(calls).toContain('unlink /srv/app/logs/a.log');
    expect(calls.indexOf('unlink /srv/app/logs/a.log')).toBeLessThan(calls.indexOf('rmdir /srv/app/logs'));
    expect(calls.indexOf('rmdir /srv/app/logs')).toBeLessThan(calls.indexOf('rmdir /srv/app'));
    expect(calls[calls.length - 1]).toBe('rmdir /srv/app');
  });

  it('still removes an empty directory', async () => {
    const { sftp, calls } = fakeSftp({ srv: { type: 'dir', children: { empty: { type: 'dir', children: {} } } } });
    const svc = new SftpManager(managerFor(sftp));
    await svc.remove(spec, '/srv/empty', true);
    expect(calls).toEqual(['rmdir /srv/empty']);
  });

  it('unlinks a symlinked directory instead of following it', async () => {
    // Following the link would delete whatever it points at — outside the tree
    // the user selected.
    const { sftp, calls } = fakeSftp({
      srv: { type: 'dir', children: { d: { type: 'dir', children: { link: { type: 'symlink', children: {} } } } } },
    });
    const svc = new SftpManager(managerFor(sftp));
    await svc.remove(spec, '/srv/d', true);
    expect(calls).toContain('unlink /srv/d/link');
    expect(calls).not.toContain('rmdir /srv/d/link');
  });

  it('refuses a pathologically deep tree rather than recursing forever', async () => {
    // 45 levels — past MAX_DELETE_DEPTH (40).
    let node: FakeNode = { type: 'dir', children: { 'f.txt': { type: 'file' } } };
    for (let i = 0; i < 45; i += 1) node = { type: 'dir', children: { deep: node } };
    const { sftp } = fakeSftp({ srv: node });
    const svc = new SftpManager(managerFor(sftp));
    await expect(svc.remove(spec, '/srv', true)).rejects.toMatchObject({ code: 'sftp_delete_too_deep' });
  });
});
