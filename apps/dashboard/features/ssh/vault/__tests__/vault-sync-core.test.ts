import { describe, it, expect } from 'vitest';
import { generateVdk, encryptJson, decryptJson, type RecordAad, type RecordEnvelope } from '@mcp/vault-crypto';
import type { SyncPullItem } from '@mcp/api-bus';
import { planVaultPush, planVaultApply, stableStringify } from '../vault-sync-core.js';

describe('vault-sync-core', () => {
  it('round-trips a host record (secrets included) through push → apply', async () => {
    const { key: vdk, vdkId } = await generateVdk();
    const enc = (v: unknown, aad: RecordAad) => encryptJson(vdk, v, aad);
    const dec = (env: RecordEnvelope, aad: RecordAad) => decryptJson<typeof host>(vdk, env, aad);
    const host = { label: 'prod', hostname: 'ex.com', port: 22, username: 'root', password: 'hunter2' };

    const { items } = await planVaultPush(
      [{ clientDocId: 'ws1:abc', kind: 'ssh_host', record: host }],
      'ws1',
      vdkId,
      enc,
      () => 0,
      () => undefined,
      1000,
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('ssh_host');

    // The server echoes the doc back at version 5.
    const pulled: SyncPullItem[] = [{ kind: 'ssh_host', clientDocId: 'ws1:abc', version: 5, deleted: false, body: items[0].body }];
    const actions = await planVaultApply(pulled, 'ws1', 'ws1', vdkId, dec, () => 0, () => 0);
    expect(actions).toHaveLength(1);
    expect(actions[0].record).toEqual(host);
    expect(actions[0].seq).toBe(1); // first push → seq 1
  });

  it('rejects a replayed/rolled-back body (seq not strictly newer)', async () => {
    const { key: vdk, vdkId } = await generateVdk();
    const enc = (v: unknown, aad: RecordAad) => encryptJson(vdk, v, aad);
    const dec = (e: RecordEnvelope, aad: RecordAad) => decryptJson(vdk, e, aad);
    const { items } = await planVaultPush(
      [{ clientDocId: 'ws1:a', kind: 'ssh_host', record: { secret: 'old' } }],
      'ws1',
      vdkId,
      enc,
      () => 0,
      () => undefined,
      1000,
    );
    const stale: SyncPullItem[] = [{ kind: 'ssh_host', clientDocId: 'ws1:a', version: 9, deleted: false, body: items[0].body }];
    // The server replays the seq-1 body under a fresh version, but we already applied seq 1.
    const actions = await planVaultApply(stale, 'ws1', 'ws1', vdkId, dec, () => 0, () => 1);
    expect(actions).toHaveLength(0); // rollback rejected
  });

  it('reuses the cached envelope for an unchanged record (no IV churn)', async () => {
    const { key: vdk, vdkId } = await generateVdk();
    let encCalls = 0;
    const enc = (v: unknown, aad: RecordAad) => {
      encCalls += 1;
      return encryptJson(vdk, v, aad);
    };
    const rec = [{ clientDocId: 'ws1:abc', kind: 'ssh_host' as const, record: { label: 'prod', hostname: 'ex.com' } }];
    const first = await planVaultPush(rec, 'ws1', vdkId, enc, () => 0, () => undefined, 1000);
    const second = await planVaultPush(rec, 'ws1', vdkId, enc, () => 0, (cid) => first.cache[cid], 2000);
    expect(encCalls).toBe(1); // second push reused the cache
    expect(second.items[0].body).toBe(first.items[0].body); // byte-identical envelope
  });

  it('filters foreign workspaces and stale versions on apply', async () => {
    const { key: vdk, vdkId } = await generateVdk();
    const env = await encryptJson(vdk, { x: 1 }, { scope: 'vault', doc: 'ws1:a', ver: 0, kid: vdkId, kind: 'ssh_host' });
    const pulled: SyncPullItem[] = [
      { kind: 'ssh_host', clientDocId: 'ws2:a', version: 9, deleted: false, body: env }, // other workspace
      { kind: 'ssh_host', clientDocId: 'ws1:a', version: 1, deleted: false, body: env }, // not newer than known=1
    ];
    const actions = await planVaultApply(pulled, 'ws1', 'ws1', vdkId, (e, aad) => decryptJson(vdk, e, aad), () => 1, () => 0);
    expect(actions).toHaveLength(0);
  });

  it('applies tombstones as deletes', async () => {
    const { vdkId } = await generateVdk();
    const pulled: SyncPullItem[] = [{ kind: 'ssh_host', clientDocId: 'ws1:gone', version: 7, deleted: true, body: null }];
    const actions = await planVaultApply(pulled, 'ws1', 'ws1', vdkId, async () => ({}), () => 0, () => 0);
    expect(actions).toEqual([{ clientDocId: 'ws1:gone', kind: 'ssh_host', version: 7, deleted: true, seq: 0, record: null }]);
  });

  it('stableStringify is key-order independent', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: [{ y: 1, x: 2 }] })).toBe(stableStringify({ a: [{ x: 2, y: 1 }] }));
  });
});
