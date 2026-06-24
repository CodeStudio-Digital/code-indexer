import { describe, expect, it } from 'vitest';
import {
  deriveKek,
  generateVdk,
  wrapVdk,
  unwrapVdk,
  encryptRecord,
  decryptRecord,
  encryptJson,
  decryptJson,
  makeVerifier,
  checkVerifier,
  generateSalt,
  randomId,
  generateRecoveryKey,
  normalizeRecoveryKey,
  deriveRecoveryKek,
  type KdfParams,
  type RecordAad,
} from '../index.js';

// Fast KDF for tests (production uses 650k); the salt is what we vary per case.
const fastParams = (salt = generateSalt()): KdfParams => ({ alg: 'PBKDF2', hash: 'SHA-256', iterations: 1000, salt });
const aad = (over: Partial<RecordAad> = {}): RecordAad => ({ scope: 'acct1', doc: 'ws:abc', ver: 3, kid: 'k1', kind: 'ssh_host', ...over });
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('vault-crypto personal key schedule', () => {
  it('round-trips a record through KEK → VDK → AES-GCM', async () => {
    const params = fastParams();
    const kek = await deriveKek('correct horse battery staple', params);
    const { key: vdk, vdkId } = await generateVdk();
    const wrapped = await wrapVdk(kek, vdk);

    const a = aad({ kid: vdkId });
    const env = await encryptRecord(vdk, bytes('id_ed25519 PRIVATE'), a);

    // Simulate a fresh device: same passphrase + salt → same KEK → unwrap same VDK.
    const kek2 = await deriveKek('correct horse battery staple', params);
    const vdk2 = await unwrapVdk(kek2, wrapped);
    expect(str(await decryptRecord(vdk2, env, a))).toBe('id_ed25519 PRIVATE');
  });

  it('throws on the wrong passphrase (unwrap fails the GCM tag)', async () => {
    const params = fastParams();
    const kek = await deriveKek('right', params);
    const { key: vdk } = await generateVdk();
    const wrapped = await wrapVdk(kek, vdk);

    const wrongKek = await deriveKek('wrong', params);
    await expect(unwrapVdk(wrongKek, wrapped)).rejects.toBeDefined();
  });

  it('fails decryption when the AAD does not match (swap/replay defense)', async () => {
    const { key: vdk } = await generateVdk();
    const env = await encryptRecord(vdk, bytes('secret'), aad());
    // Wrong doc / wrong version / wrong scope each fail the tag.
    await expect(decryptRecord(vdk, env, aad({ doc: 'ws:other' }))).rejects.toBeDefined();
    await expect(decryptRecord(vdk, env, aad({ ver: 4 }))).rejects.toBeDefined();
    await expect(decryptRecord(vdk, env, aad({ scope: 'acct2' }))).rejects.toBeDefined();
  });

  it('detects ciphertext tampering', async () => {
    const { key: vdk } = await generateVdk();
    const env = await encryptRecord(vdk, bytes('secret'), aad());
    const raw = atob(env.ct);
    const flipped = btoa(String.fromCharCode(raw.charCodeAt(0) ^ 0xff) + raw.slice(1));
    await expect(decryptRecord(vdk, { ...env, ct: flipped }, aad())).rejects.toBeDefined();
  });

  it('uses a unique IV per encryption', async () => {
    const { key: vdk } = await generateVdk();
    const ivs = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const env = await encryptRecord(vdk, bytes('x'), aad());
      ivs.add(env.iv);
    }
    expect(ivs.size).toBe(500);
  });

  it('verifier confirms the right VDK and rejects a different one', async () => {
    const { key: vdk } = await generateVdk();
    const verifier = await makeVerifier(vdk);
    expect(await checkVerifier(vdk, verifier)).toBe(true);
    const { key: other } = await generateVdk();
    expect(await checkVerifier(other, verifier)).toBe(false);
  });

  it('round-trips JSON records', async () => {
    const { key: vdk, vdkId } = await generateVdk();
    const a = aad({ kid: vdkId });
    const value = { host: 'ex.com', port: 22, password: 'hunter2' };
    const env = await encryptJson(vdk, value, a);
    expect(await decryptJson<typeof value>(vdk, env, a)).toEqual(value);
  });

  it('generates distinct ids/salts', () => {
    expect(randomId()).not.toBe(randomId());
    expect(generateSalt()).not.toBe(generateSalt());
  });
});

describe('vault-crypto recovery key', () => {
  it('unwraps the SAME VDK with the recovery key (escrow-free recovery)', async () => {
    const { key: vdk } = await generateVdk();
    const verifier = await makeVerifier(vdk);
    const recoveryKey = generateRecoveryKey();
    const rKdf = fastParams();
    const rKek = await deriveRecoveryKek(recoveryKey, rKdf);
    const wrapped = await wrapVdk(rKek, vdk);

    // Later, on a device that lost the passphrase: same recovery key → same VDK.
    const rKek2 = await deriveRecoveryKek(recoveryKey, rKdf);
    const vdk2 = await unwrapVdk(rKek2, wrapped);
    expect(await checkVerifier(vdk2, verifier)).toBe(true);
  });

  it('rejects a wrong recovery key', async () => {
    const { key: vdk } = await generateVdk();
    const rKdf = fastParams();
    const wrapped = await wrapVdk(await deriveRecoveryKek(generateRecoveryKey(), rKdf), vdk);
    await expect(unwrapVdk(await deriveRecoveryKek(generateRecoveryKey(), rKdf), wrapped)).rejects.toBeDefined();
  });

  it('normalizes grouping, case, and visual confusables to one canonical key', () => {
    expect(normalizeRecoveryKey('K7Q2-9F3M')).toBe('K7Q29F3M');
    expect(normalizeRecoveryKey('k7q2 9f3m')).toBe('K7Q29F3M');
    // I/L→1, O→0, U→V (Crockford); so a transcription slip still derives the same KEK.
    expect(normalizeRecoveryKey('OIL-U')).toBe('011V');
  });

  it('derives the same KEK from grouped/lowercase variants of one key', async () => {
    const rKdf = fastParams();
    const key = generateRecoveryKey(); // e.g. AAAA-BBBB-...
    const a = await deriveRecoveryKek(key, rKdf);
    const b = await deriveRecoveryKek(key.toLowerCase().replace(/-/g, ' '), rKdf);
    const { key: vdk } = await generateVdk();
    const wrapped = await wrapVdk(a, vdk);
    await expect(unwrapVdk(b, wrapped)).resolves.toBeDefined(); // same KEK ⇒ unwraps
  });

  it('generates distinct, well-formed recovery keys', () => {
    const k = generateRecoveryKey();
    expect(k).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/);
    expect(generateRecoveryKey()).not.toBe(generateRecoveryKey());
  });
});
