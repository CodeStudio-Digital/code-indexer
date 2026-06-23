import { describe, expect, it } from 'vitest';
import {
  generateIdentityKeyPair,
  wrapIdentityPrivate,
  unwrapIdentityPrivate,
  generateTvk,
  wrapTvkForMember,
  unwrapTvkFromMember,
  generateSigningKeyPair,
  signGrant,
  verifyGrantSig,
  encryptJson,
  decryptJson,
  deriveKek,
  defaultKdfParams,
  type RecordAad,
} from '../index.js';

const aad = (kid: string): RecordAad => ({ scope: 'org1', doc: 'ws:a', ver: 0, kid, kind: 'ssh_host' });

describe('vault-crypto team sharing', () => {
  it('shares a TVK from an admin to a member (zero-knowledge)', async () => {
    const alice = await generateIdentityKeyPair(); // admin / granter
    const bob = await generateIdentityKeyPair(); // member
    const { key: tvk, tvkId } = await generateTvk();

    // Alice wraps the TVK to Bob's public key.
    const grant = await wrapTvkForMember(alice, bob.publicSpki, tvk, tvkId);

    // Bob unwraps it with his private key and decrypts a record Alice encrypted.
    const bobTvk = await unwrapTvkFromMember(bob.privatePkcs8, grant);
    const env = await encryptJson(tvk, { host: 'prod', password: 'hunter2' }, aad(tvkId));
    expect(await decryptJson(bobTvk, env, aad(tvkId))).toEqual({ host: 'prod', password: 'hunter2' });
  });

  it('an outsider cannot unwrap a grant meant for someone else', async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const carol = await generateIdentityKeyPair(); // not the recipient
    const { key: tvk, tvkId } = await generateTvk();
    const grant = await wrapTvkForMember(alice, bob.publicSpki, tvk, tvkId);
    await expect(unwrapTvkFromMember(carol.privatePkcs8, grant)).rejects.toBeDefined();
  });

  it('wraps + unwraps the identity private key under the personal KEK', async () => {
    const id = await generateIdentityKeyPair();
    const kek = await deriveKek('pass', { ...defaultKdfParams(), iterations: 1000 });
    const wrapped = await wrapIdentityPrivate(kek, id.privatePkcs8);
    expect(await unwrapIdentityPrivate(kek, wrapped)).toBe(id.privatePkcs8);

    const wrongKek = await deriveKek('other', { ...defaultKdfParams(), iterations: 1000 });
    await expect(unwrapIdentityPrivate(wrongKek, wrapped)).rejects.toBeDefined();
  });

  it('signs + verifies a grant; rejects forgery and key substitution', async () => {
    const adminSig = await generateSigningKeyPair();
    const recipient = await generateIdentityKeyPair();
    const { tvkId } = await generateTvk();
    const wrapped = 'wrapped-blob-base64';

    const sig = await signGrant(adminSig.privatePkcs8, tvkId, recipient.publicSpki, wrapped);
    expect(await verifyGrantSig(adminSig.publicSpki, tvkId, recipient.publicSpki, wrapped, sig)).toBe(true);

    // Tampering with any signed field is detected (server can't forge a grant).
    expect(await verifyGrantSig(adminSig.publicSpki, 'other-tvk', recipient.publicSpki, wrapped, sig)).toBe(false);
    expect(await verifyGrantSig(adminSig.publicSpki, tvkId, recipient.publicSpki, 'evil-wrapped', sig)).toBe(false);
    const attacker = await generateIdentityKeyPair();
    expect(await verifyGrantSig(adminSig.publicSpki, tvkId, attacker.publicSpki, wrapped, sig)).toBe(false);

    // A signature from a DIFFERENT (attacker) signing key fails against the pinned admin key.
    const attackerSig = await generateSigningKeyPair();
    const forged = await signGrant(attackerSig.privatePkcs8, tvkId, recipient.publicSpki, wrapped);
    expect(await verifyGrantSig(adminSig.publicSpki, tvkId, recipient.publicSpki, wrapped, forged)).toBe(false);
  });

  it('rotation: a new TVK re-wrapped to remaining members; the old grant no longer decrypts new records', async () => {
    const admin = await generateIdentityKeyPair();
    const member = await generateIdentityKeyPair();
    const tvk1 = await generateTvk();
    const tvk2 = await generateTvk(); // rotated key

    const grant2 = await wrapTvkForMember(admin, member.publicSpki, tvk2.key, tvk2.tvkId);
    const memberTvk2 = await unwrapTvkFromMember(member.privatePkcs8, grant2);

    // A record encrypted under the rotated key decrypts with the new grant…
    const env = await encryptJson(tvk2.key, { x: 1 }, aad(tvk2.tvkId));
    expect(await decryptJson(memberTvk2, env, aad(tvk2.tvkId))).toEqual({ x: 1 });
    // …but not under the old TVK.
    await expect(decryptJson(tvk1.key, env, aad(tvk2.tvkId))).rejects.toBeDefined();
  });
});
