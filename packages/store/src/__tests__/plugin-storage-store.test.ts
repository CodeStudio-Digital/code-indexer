import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../index.js';
import { PluginStorageStore } from '../plugin-storage-store.js';
import { InstalledPluginStore } from '../installed-plugin-store.js';

let dir: string;
let dbIndex: CodeIndexDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-storage-'));
  // CodeIndexDB runs initSchema + all migrations (incl. 116/117) on construct.
  dbIndex = new CodeIndexDB(join(dir, 'test.db'));
});

afterEach(() => {
  dbIndex.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PluginStorageStore', () => {
  it('set/get/list/delete round-trips and isolates namespaces', () => {
    const s = new PluginStorageStore(dbIndex.raw());

    expect(s.get('cf', 'token')).toBeNull();

    s.set('cf', 'token', 'abc');
    s.set('cf', 'account', 'acct1');
    s.set('other', 'token', 'xyz');

    expect(s.get('cf', 'token')).toBe('abc');
    expect(s.listKeys('cf')).toEqual(['account', 'token']);
    expect(s.get('other', 'token')).toBe('xyz');

    // upsert overwrites
    s.set('cf', 'token', 'def');
    expect(s.get('cf', 'token')).toBe('def');

    // single-key delete
    s.delete('cf', 'token');
    expect(s.get('cf', 'token')).toBeNull();
    expect(s.listKeys('cf')).toEqual(['account']);

    // namespace teardown leaves other namespaces untouched
    s.deleteNamespace('cf');
    expect(s.listKeys('cf')).toEqual([]);
    expect(s.get('other', 'token')).toBe('xyz');
  });

  it('persists permissions_granted on installed_plugins', () => {
    const store = new InstalledPluginStore(dbIndex.raw());
    store.upsert({ namespace: 'cf', name: 'cloudflare', version: '0.1.0', source: 'local' });

    expect(store.get('cf')?.permissions_granted).toBeNull();
    store.setPermissionsGranted('cf', { fs: { read: ['wrangler.toml'] }, storage: true });
    expect(store.get('cf')?.permissions_granted).toEqual({
      fs: { read: ['wrangler.toml'] },
      storage: true,
    });
  });
});
