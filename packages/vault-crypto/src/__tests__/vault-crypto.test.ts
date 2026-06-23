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
