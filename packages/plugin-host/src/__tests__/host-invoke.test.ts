import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { PluginStorageStore } from '@mcp/store/plugin-storage-store.js';
import { buildHostInvoke } from '../host-invoke.js';

let dir: string;
let db: CodeIndexDB;
let storage: PluginStorageStore;

const grants = { fs: { read: ['ok.txt'] }, storage: true };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-invoke-'));
  db = new CodeIndexDB(join(dir, 't.db'));
  storage = new PluginStorageStore(db.raw());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function make() {
  return buildHostInvoke({ resolveGrants: (ns) => (ns === 'cf' ? grants : null), storage });
}

describe('buildHostInvoke', () => {
  it('denies an unknown method (no readOnlyApi passthrough)', async () => {
    await expect(make()('weird.method', {}, 'cf', dir)).rejects.toThrow(/permission_denied/);
  });

  it('denies fs read for a namespace with no grants', async () => {
    writeFileSync(join(dir, 'ok.txt'), 'hi');
    await expect(make()('fs.readFile', { path: 'ok.txt' }, 'other', dir)).rejects.toThrow(
      /permission_denied/,
    );
  });

  it('reads a granted file through the choke point', async () => {
    writeFileSync(join(dir, 'ok.txt'), 'hi');
    expect(await make()('fs.readFile', { path: 'ok.txt' }, 'cf', dir)).toBe('hi');
  });

  it('round-trips storage when granted, scoped by namespace', async () => {
    const h = make();
    await h('storage.set', { key: 'k', value: 'v' }, 'cf', dir);
    expect(await h('storage.get', { key: 'k' }, 'cf', dir)).toBe('v');
  });

  it('denies storage for an ungranted namespace', async () => {
    await expect(make()('storage.get', { key: 'k' }, 'other', dir)).rejects.toThrow(
      /permission_denied/,
    );
  });

  it('routes whitelisted host.* methods to readOnlyApi', async () => {
    const h = buildHostInvoke({
      resolveGrants: () => null,
      storage,
      readOnlyApi: async (method) => ({ method }),
    });
    expect(await h('projects.list', {}, 'cf', dir)).toEqual({ method: 'projects.list' });
  });
});
