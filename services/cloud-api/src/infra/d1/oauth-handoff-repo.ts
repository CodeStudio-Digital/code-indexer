/** OAuthHandoffRepo — one-time codes bridging the worker callback → desktop
 *  loopback / web portal. Only the SHA-256 of the code is stored. `claim` is the
 *  atomic single-use gate (UPDATE ... WHERE consumed_at IS NULL AND not expired),
 *  mirroring auth-token-repo's idiom; a replay finds it consumed and gets null. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import { sha256Hex } from '../sha256.js';

export interface OAuthHandoffRepo {
  create(code: string, payload: string, expiresAtMs: number): Promise<void>;
  /** Atomically consume the code; returns its payload iff THIS call claimed it. */
  claim(code: string, atIso: string): Promise<string | null>;
}

export function createOAuthHandoffRepo(db: DbExecutor): OAuthHandoffRepo {
  return {
    async create(code, payload, expiresAtMs) {
      const codeHash = await sha256Hex(code);
      await db.run('INSERT INTO oauth_handoffs (code_hash, payload, expires_at) VALUES (?, ?, ?)', [
        codeHash,
        payload,
        expiresAtMs,
      ]);
    },
    async claim(code, atIso) {
      const codeHash = await sha256Hex(code);
      const res = await db.run(
        "UPDATE oauth_handoffs SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > (unixepoch('now') * 1000)",
        [atIso, codeHash],
      );
      if (res.rowsAffected === 0) return null;
      const row = await db.first<{ payload: string }>('SELECT payload FROM oauth_handoffs WHERE code_hash = ?', [codeHash]);
      return row?.payload ?? null;
    },
  };
}
