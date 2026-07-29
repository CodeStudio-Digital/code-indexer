/**
 * Regression — `shareWithOrg` used to publish EVERY host in the project (the
 * union of project-local and globally-shared hosts) with each password and
 * private key decrypted and inlined into the record, to every org member, with
 * no per-host choice, no preview and no confirmation.
 *
 * These are the rules that now decide what actually escapes the machine, so
 * they are pinned here rather than left to the dialog.
 */
import { describe, expect, it } from 'vitest';
import {
  buildShareCandidates,
  resolveShareSelection,
  secretKindsOf,
  summarizeShare,
  type ShareChoice,
} from '../share-selection.js';
import { hostToRecord } from '../record-mapping.js';
import type { SshHost } from '../../types.js';

const host = (over: Partial<SshHost> & { id: number }): SshHost =>
  ({
    is_shared: 0,
    storage_scope: 'project',
    label: `host-${over.id}`,
    hostname: 'ex.com',
    port: 22,
    username: 'root',
    auth_method: 'password',
    enc_password: null,
    enc_private_key: null,
    enc_passphrase: null,
    group_name: null,
    tags_json: '[]',
    agent_forwarding: 0,
    ...over,
  }) as SshHost;

describe('share selection — what leaves the machine', () => {
  it('lists the credential kinds a host actually holds', () => {
    expect(secretKindsOf(host({ id: 1 }))).toEqual([]);
    expect(secretKindsOf(host({ id: 2, enc_password: 'enc:x' }))).toEqual(['password']);
    expect(secretKindsOf(host({ id: 3, enc_private_key: 'enc:k', enc_passphrase: 'enc:p' }))).toEqual([
      'privateKey',
      'passphrase',
    ]);
  });

  it('builds a distinct row per host even when ids collide across scopes', () => {
    const rows = buildShareCandidates([host({ id: 3, is_shared: 1, storage_scope: 'shared' }), host({ id: 3 })]);
    expect(rows.map((r) => r.hostKey)).toEqual(['shared:3', 'project:3']);
    expect(rows[0].isShared).toBe(true);
    expect(rows[1].isShared).toBe(false);
  });

  it('shares ONLY the ticked hosts — never the whole list', () => {
    const hosts = [host({ id: 1 }), host({ id: 2 }), host({ id: 3 })];
    const selection: ShareChoice[] = [{ hostKey: 'project:2', includeCredentials: false }];
    const resolved = resolveShareSelection(hosts, selection);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].host.id).toBe(2);
  });

  it('drops a selected host that no longer exists (stale dialog snapshot)', () => {
    const resolved = resolveShareSelection(
      [host({ id: 1 })],
      [{ hostKey: 'project:99', includeCredentials: true }],
    );
    expect(resolved).toEqual([]);
  });

  it('never widens into a host added after the dialog opened', () => {
    const resolved = resolveShareSelection(
      [host({ id: 1 }), host({ id: 2 })],
      [{ hostKey: 'project:1', includeCredentials: false }],
    );
    expect(resolved.map((r) => r.host.id)).toEqual([1]);
  });

  it('a duplicated choice publishes the host once', () => {
    const resolved = resolveShareSelection(
      [host({ id: 1 })],
      [
        { hostKey: 'project:1', includeCredentials: false },
        { hostKey: 'project:1', includeCredentials: true },
      ],
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].includeCredentials).toBe(false); // first choice wins, the safer one here
  });

  describe('impact summary (what the confirm button promises)', () => {
    const candidates = buildShareCandidates([
      host({ id: 1, enc_password: 'enc:x' }),
      host({ id: 2, enc_private_key: 'enc:k', enc_passphrase: 'enc:p' }),
      host({ id: 3 }), // agent auth, nothing stored
    ]);

    it('counts zero credentials when nothing is opted in', () => {
      const impact = summarizeShare(candidates, [
        { hostKey: 'project:1', includeCredentials: false },
        { hostKey: 'project:2', includeCredentials: false },
      ]);
      expect(impact).toEqual({ hosts: 2, withCredentials: 0, secrets: 0 });
    });

    it('counts each individual secret that would travel', () => {
      const impact = summarizeShare(candidates, [
        { hostKey: 'project:1', includeCredentials: true },
        { hostKey: 'project:2', includeCredentials: true },
      ]);
      expect(impact).toEqual({ hosts: 2, withCredentials: 2, secrets: 3 });
    });

    it('does NOT inflate the count for a host with nothing to send', () => {
      // Ticking "include credentials" on an agent-auth host must not read as a
      // leak, or the warning stops meaning anything.
      const impact = summarizeShare(candidates, [{ hostKey: 'project:3', includeCredentials: true }]);
      expect(impact).toEqual({ hosts: 1, withCredentials: 0, secrets: 0 });
    });
  });
});

describe('record mapping — credentials only travel when opted in', () => {
  it('omits every secret and never calls decrypt when includeCredentials is false', async () => {
    // decryptSecret would THROW here (no keychain bridge in a plain test), so a
    // clean return is itself proof that no decryption was attempted.
    const rec = await hostToRecord(
      host({ id: 1, enc_password: 'enc:x', enc_private_key: 'enc:k', enc_passphrase: 'enc:p' }),
      { includeCredentials: false },
    );
    expect(rec.password).toBeUndefined();
    expect(rec.privateKey).toBeUndefined();
    expect(rec.passphrase).toBeUndefined();
    expect(rec.hostname).toBe('ex.com');
    expect(rec.username).toBe('root');
    // The method is downgraded: advertising `password` while withholding the
    // password would just produce a confusing failed auth on the recipient.
    expect(rec.auth_method).toBe('agent');
  });

  it('carries the endpoint metadata a teammate needs to connect with their own key', async () => {
    const rec = await hostToRecord(
      host({ id: 1, label: 'prod-db', hostname: 'db.internal', port: 2222, username: 'deploy', enc_password: 'enc:x' }),
      { includeCredentials: false },
    );
    expect(rec).toMatchObject({ label: 'prod-db', hostname: 'db.internal', port: 2222, username: 'deploy' });
  });
});
