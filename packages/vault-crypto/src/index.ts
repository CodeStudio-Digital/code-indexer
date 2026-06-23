/**
 * @mcp/vault-crypto — zero-knowledge crypto for the SSH credential vault.
 *
 * Pure WebCrypto (SubtleCrypto), no native deps, runs in the Electron renderer
 * AND main AND Node (vitest). The Cloudflare Worker imports NONE of this — it
 * only ever stores opaque ciphertext + public keys.
 *
 * Key schedule (single user, multi-device):
 *   passphrase --PBKDF2(650k,SHA-256)--> KEK (AES-256-GCM)
 *   KEK --AES-GCM wrap--> VDK (random AES-256-GCM data key)
 *   VDK --AES-GCM(iv, AAD)--> each host/identity record
 *
 * The indirection (passphrase→KEK wraps a random VDK) lets the passphrase
 * change without re-encrypting the corpus, and lets every device share one VDK
 * by each unwrapping it from the passphrase. The KEK never leaves the device;
 * the server only sees the wrapped VDK + ciphertext records.
 *
 * Wrapping uses AES-GCM (not AES-KW) uniformly: it gives authenticated unwrap
 * (a wrong passphrase fails the GCM tag → throws) without AES-KW's 64-bit
 * length constraint, so the same primitive wraps 32-byte data keys and
 * variable-length private keys alike.
 *
 * IV note: every record uses a fresh random 96-bit IV (never a counter), and one
 * VDK/TVK is shared across devices with no IV coordination. This relies on the
 * random-IV birthday bound: stay well below ~2^32 encryptions PER KEY. For an SSH
 * credential vault (thousands of records, edited occasionally) that ceiling is
 * never approached; if record volume could ever grow large, switch to a
 * per-device IV prefix + counter or rotate the VDK.
 */

const PBKDF2_ITERATIONS = 650_000;
const IV_BYTES = 12;
const subtle = (): SubtleCrypto => crypto.subtle;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/**
 * Coerce a byte array to `BufferSource` for WebCrypto. Newer lib.dom types
 * `Uint8Array<ArrayBufferLike>` which the SubtleCrypto signatures (narrowed to
 * ArrayBuffer-backed views) reject; the runtime accepts any ArrayBufferView, so
 * this cast is sound.
 */
const bs = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

// ─── base64 (portable: btoa/atob exist in browsers + Node 16+) ───────────
function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Random base64 salt for a new vault (32 bytes). */
export function generateSalt(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}

/** Short random hex id (for vdkId/tvkId). */
export function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── KDF → KEK ───────────────────────────────────────────────────────────
export interface KdfParams {
  alg: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  /** base64 salt. */
  salt: string;
}

export function defaultKdfParams(): KdfParams {
  return { alg: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: generateSalt() };
}

/** Derive the (non-extractable) key-encryption key from the vault passphrase. */
export async function deriveKek(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', bs(utf8(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: bs(b64decode(params.salt)), iterations: params.iterations, hash: params.hash },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── AES-GCM wrap of raw key material (authenticated) ────────────────────
async function gcmWrap(kek: CryptoKey, raw: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: bs(iv) }, kek, bs(raw)));
  return b64encode(concat(iv, ct));
}
async function gcmUnwrap(kek: CryptoKey, blob: string): Promise<Uint8Array> {
  const bytes = b64decode(blob);
  const iv = bytes.subarray(0, IV_BYTES);
  const ct = bytes.subarray(IV_BYTES);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: bs(iv) }, kek, bs(ct))); // throws on wrong KEK
}

// ─── Vault Data Key (VDK) ─────────────────────────────────────────────────
async function importVdk(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', bs(raw), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function generateVdk(): Promise<{ key: CryptoKey; vdkId: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { key: await importVdk(raw), vdkId: randomId() };
}

/** Wrap the VDK under the passphrase-derived KEK (for the synced vault_meta doc). */
export async function wrapVdk(kek: CryptoKey, vdk: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await subtle().exportKey('raw', vdk));
  return gcmWrap(kek, raw);
}

/** Unwrap the VDK; THROWS on a wrong passphrase (GCM tag mismatch). */
export async function unwrapVdk(kek: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return importVdk(await gcmUnwrap(kek, wrapped));
}

// ─── Record envelope ──────────────────────────────────────────────────────
/** Bound into the GCM AAD so a record can't be swapped/replayed to another slot. */
export interface RecordAad {
  /** account_id (personal) or org_id (team). */
  scope: string;
  /** clientDocId of this record. */
  doc: string;
  /** sync version this body is bound to. */
  ver: number;
  /** which data key (vdkId/tvkId). */
  kid: string;
  /** SyncKind. */
  kind: string;
}

export interface RecordEnvelope {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
  kid: string;
  /**
   * Client-assigned monotonic per-doc sequence, bound into the AAD (`ver`). The
   * decryptor recomputes the AAD from THIS value, so a server can't change it
   * without failing the GCM tag — and the apply side rejects any body whose seq
   * doesn't strictly advance, defeating rollback/replay/resurrection.
   */
  seq: number;
}

/** Stable, sorted-key JSON so AAD bytes are identical across devices/languages. */
function aadBytes(aad: RecordAad): Uint8Array {
  const ordered = { doc: aad.doc, kid: aad.kid, kind: aad.kind, scope: aad.scope, ver: aad.ver };
  return utf8(JSON.stringify(ordered));
}

export async function encryptRecord(vdk: CryptoKey, plaintext: Uint8Array, aad: RecordAad): Promise<RecordEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aadBytes(aad)) }, vdk, bs(plaintext)),
  );
  return { v: 1, alg: 'A256GCM', iv: b64encode(iv), ct: b64encode(ct), kid: aad.kid, seq: aad.ver };
}

/**
 * Decrypt a record. The caller passes the AAD it INDEPENDENTLY recomputes from
 * the record's real feed coordinates (never trusting the envelope) — a mismatch
 * fails the GCM tag, defeating swap/splice/rollback. THROWS on tamper.
 */
export async function decryptRecord(vdk: CryptoKey, env: RecordEnvelope, expectedAad: RecordAad): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: bs(b64decode(env.iv)), additionalData: bs(aadBytes(expectedAad)) },
    vdk,
    bs(b64decode(env.ct)),
  );
  return new Uint8Array(pt);
}

/** Convenience: encrypt/decrypt a JSON-serialisable record. */
export async function encryptJson(vdk: CryptoKey, value: unknown, aad: RecordAad): Promise<RecordEnvelope> {
  return encryptRecord(vdk, utf8(JSON.stringify(value)), aad);
}
export async function decryptJson<T>(vdk: CryptoKey, env: RecordEnvelope, expectedAad: RecordAad): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await decryptRecord(vdk, env, expectedAad))) as T;
}

// ─── Passphrase verifier (for unlocking a 2nd device without a server oracle) ─
/**
 * A small token a new device decrypts to confirm the passphrase is right BEFORE
 * pulling records — derived from the VDK, stored in vault_meta. Zero server
 * knowledge: the server can't produce or verify it.
 */
export async function makeVerifier(vdk: CryptoKey): Promise<RecordEnvelope> {
  const aad: RecordAad = { scope: 'verify', doc: 'verify', ver: 0, kid: 'verify', kind: 'verify' };
  return encryptRecord(vdk, utf8('ok'), aad);
}
export async function checkVerifier(vdk: CryptoKey, env: RecordEnvelope): Promise<boolean> {
  try {
    const aad: RecordAad = { scope: 'verify', doc: 'verify', ver: 0, kid: 'verify', kind: 'verify' };
    return new TextDecoder().decode(await decryptRecord(vdk, env, aad)) === 'ok';
  } catch {
    return false;
  }
}

// ─── Team sharing: ECDH identity keypair + Team Vault Key (TVK) wrapping ───
//
// Each member has a long-lived ECDH P-256 identity keypair. The PUBLIC key is
// published to the server (so anyone can wrap to them); the PRIVATE key is
// wrapped under the member's own personal KEK (so it syncs with their vault).
// A shared project gets a random TVK; an admin wraps it to each member's public
// key via ECDH→HKDF→AES-GCM. Only a wrapped-grant holder can decrypt — the
// server stays zero-knowledge. P-256 (not X25519) for universal WebCrypto.

export interface GeneratedIdentity {
  /** base64 SPKI public key — publish to the server. */
  publicSpki: string;
  /** base64 PKCS8 private key — wrap under the personal KEK before storing. */
  privatePkcs8: string;
}

export async function generateIdentityKeyPair(): Promise<GeneratedIdentity> {
  const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    publicSpki: b64encode(await subtle().exportKey('spki', pair.publicKey)),
    privatePkcs8: b64encode(await subtle().exportKey('pkcs8', pair.privateKey)),
  };
}

export function importIdentityPrivate(privatePkcs8: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', bs(b64decode(privatePkcs8)), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}
function importIdentityPublic(publicSpki: string): Promise<CryptoKey> {
  return subtle().importKey('spki', bs(b64decode(publicSpki)), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/** Wrap/unwrap the identity private key under the personal KEK (lives in vault_meta). */
export function wrapIdentityPrivate(kek: CryptoKey, privatePkcs8: string): Promise<string> {
  return gcmWrap(kek, b64decode(privatePkcs8));
}
export async function unwrapIdentityPrivate(kek: CryptoKey, wrapped: string): Promise<string> {
  return b64encode(await gcmUnwrap(kek, wrapped));
}

export async function generateTvk(): Promise<{ key: CryptoKey; tvkId: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { key: await importVdk(raw), tvkId: randomId() };
}

/** ECDH(myPriv, theirPub) → HKDF → AES-GCM wrapping key, domain-separated per TVK. */
async function ecdhWrapKey(myPriv: CryptoKey, theirPub: CryptoKey, tvkId: string): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: theirPub }, myPriv, 256);
  const hk = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(utf8(tvkId)), info: bs(utf8('cs-tvk-wrap-v1')) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A TVK wrapped to one member. Carries the granter's pubkey so the member can re-derive the ECDH secret. */
export interface WrappedTvk {
  wrapped: string;
  granterPub: string;
  tvkId: string;
}

/** Wrap a TVK to a recipient's public key (run by a current TVK holder). */
export async function wrapTvkForMember(
  granter: { privatePkcs8: string; publicSpki: string },
  recipientPublicSpki: string,
  tvk: CryptoKey,
  tvkId: string,
): Promise<WrappedTvk> {
  const myPriv = await importIdentityPrivate(granter.privatePkcs8);
  const theirPub = await importIdentityPublic(recipientPublicSpki);
  const wrapKey = await ecdhWrapKey(myPriv, theirPub, tvkId);
  const raw = new Uint8Array(await subtle().exportKey('raw', tvk));
  return { wrapped: await gcmWrap(wrapKey, raw), granterPub: granter.publicSpki, tvkId };
}

/** Unwrap a TVK grant with my identity private key (ECDH is symmetric). */
export async function unwrapTvkFromMember(myPrivatePkcs8: string, grant: WrappedTvk): Promise<CryptoKey> {
  const myPriv = await importIdentityPrivate(myPrivatePkcs8);
  const granterPub = await importIdentityPublic(grant.granterPub);
  const wrapKey = await ecdhWrapKey(myPriv, granterPub, grant.tvkId);
  return importVdk(await gcmUnwrap(wrapKey, grant.wrapped));
}

// ─── Grant authentication: a separate ECDSA P-256 SIGNING keypair ──────────
//
// ECDH+HKDF+GCM gives confidentiality but NOT sender authentication, so a
// malicious server could forge a grant (wrap a TVK it controls) or substitute a
// member's public key undetected. The granter SIGNS each grant; the recipient
// verifies against the granter's PINNED signing key. This closes both the
// grant-forgery and key-substitution vectors.

export async function generateSigningKeyPair(): Promise<GeneratedIdentity> {
  const pair = (await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    publicSpki: b64encode(await subtle().exportKey('spki', pair.publicKey)),
    privatePkcs8: b64encode(await subtle().exportKey('pkcs8', pair.privateKey)),
  };
}

/** Canonical bytes a grant signature covers — binds the key to its recipient + TVK. */
function grantPayload(tvkId: string, recipientPub: string, wrapped: string): Uint8Array {
  return utf8(`${tvkId}\n${recipientPub}\n${wrapped}`);
}

export async function signGrant(
  sigPrivatePkcs8: string,
  tvkId: string,
  recipientPub: string,
  wrapped: string,
): Promise<string> {
  const key = await subtle().importKey('pkcs8', bs(b64decode(sigPrivatePkcs8)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bs(grantPayload(tvkId, recipientPub, wrapped)));
  return b64encode(sig);
}

export async function verifyGrantSig(
  sigPublicSpki: string,
  tvkId: string,
  recipientPub: string,
  wrapped: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await subtle().importKey('spki', bs(b64decode(sigPublicSpki)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bs(b64decode(signature)), bs(grantPayload(tvkId, recipientPub, wrapped)));
  } catch {
    return false;
  }
}
