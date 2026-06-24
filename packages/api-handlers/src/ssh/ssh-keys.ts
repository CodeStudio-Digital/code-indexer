/**
 * In-app SSH keypair generation (P7) — ed25519 (default) or RSA, in OpenSSH
 * format, via ssh2's pure-JS keygen. The PRIVATE key is returned once to the
 * renderer, which seals it with the OS keychain before persisting as an
 * identity; the PUBLIC key is shown so the user can add it to the server's
 * `~/.ssh/authorized_keys`.
 */
import { createHash } from 'node:crypto';
// ssh2 is CommonJS. Under Node's native ESM loader, cjs-module-lexer only
// surfaces a handful of ssh2's named exports — it bails right after `Client`,
// so `utils` is NOT importable as `{ utils }` (throws "does not provide an
// export named 'utils'"). Reach it through the default import, which is the
// full `module.exports` object. (esModuleInterop is on, so this also types.)
import ssh2 from 'ssh2';
import { ApiError } from '@mcp/api-bus';

const { utils: sshUtils } = ssh2;

export interface GenerateKeyResult {
  /** OpenSSH public key line: `ssh-ed25519 AAAA… comment`. */
  publicKey: string;
  /** OpenSSH private key (`-----BEGIN OPENSSH PRIVATE KEY-----`), passphrase-encrypted if requested. */
  privateKey: string;
  /** `ssh-ed25519` | `ssh-rsa`. */
  keyType: string;
  /** OpenSSH SHA-256 fingerprint (`SHA256:…`). */
  fingerprint: string;
}

export function generateSshKey(input: {
  type?: 'ed25519' | 'rsa';
  bits?: number;
  comment?: string;
  passphrase?: string;
}): GenerateKeyResult {
  const type = input.type === 'rsa' ? 'rsa' : 'ed25519';
  const comment = input.comment?.trim() || undefined;
  // ssh2 needs cipher + rounds alongside a passphrase to encrypt the private key.
  const pp = input.passphrase ? { passphrase: input.passphrase, cipher: 'aes256-cbc', rounds: 16 } : null;
  let pair: { private: string; public: string };
  try {
    if (type === 'rsa') {
      const bits = input.bits && input.bits >= 2048 ? input.bits : 4096;
      pair = pp
        ? sshUtils.generateKeyPairSync('rsa', { bits, comment, passphrase: pp.passphrase, cipher: pp.cipher, rounds: pp.rounds })
        : sshUtils.generateKeyPairSync('rsa', { bits, comment });
    } else {
      pair = pp
        ? sshUtils.generateKeyPairSync('ed25519', { comment, passphrase: pp.passphrase, cipher: pp.cipher, rounds: pp.rounds })
        : sshUtils.generateKeyPairSync('ed25519', { comment });
    }
  } catch (e) {
    throw new ApiError('ssh_keygen_failed', 500, e instanceof Error ? e.message : String(e));
  }
  return {
    publicKey: pair.public.trim(),
    privateKey: pair.private,
    keyType: type === 'rsa' ? 'ssh-rsa' : 'ssh-ed25519',
    fingerprint: fingerprintOf(pair.public),
  };
}

/** OpenSSH SHA-256 fingerprint = base64(sha256(raw key blob)), no padding, `SHA256:` prefixed. */
function fingerprintOf(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  if (!parts[1]) return '';
  const hash = createHash('sha256').update(Buffer.from(parts[1], 'base64')).digest('base64').replace(/=+$/, '');
  return `SHA256:${hash}`;
}
