/**
 * Trust-on-first-use (TOFU) host-key store for the embedded SSH client.
 *
 * Persists accepted host keys to `<dataDir>/ssh/known_hosts.json`, keyed by
 * `host:port`. The connection manager consults it during the SSH handshake
 * (`hostVerifier`): a matching key is accepted silently, a missing key is
 * rejected so the UI can prompt for trust, and a CHANGED key is rejected
 * hard (possible MITM) and never auto-trusted.
 *
 * This is intentionally a small JSON file (not the OpenSSH `known_hosts`
 * format) — we only need fingerprint equality, and seeding from the user's
 * real `~/.ssh/known_hosts` is a later, read-only enhancement.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KnownHostEntry {
  /** OpenSSH-form SHA-256 fingerprint: `SHA256:<base64nopad>`. */
  fingerprint: string;
  /** SSH key algorithm, e.g. `ssh-ed25519`. */
  keyType: string;
  /** When the key was first trusted (epoch ms). */
  trustedAtMs: number;
}

type KnownHostsFile = Record<string, KnownHostEntry>;

const keyOf = (host: string, port: number): string => `${host}:${port}`;

export class KnownHostsStore {
  private cache: KnownHostsFile | null = null;

  constructor(private readonly filePath: string) {}

  private load(): KnownHostsFile {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      // Missing file → fresh store (the common first-run case).
      this.cache = {};
      return this.cache;
    }
    try {
      this.cache = JSON.parse(raw) as KnownHostsFile;
    } catch {
      // File EXISTS but is corrupt (e.g. a truncated write). Do NOT silently
      // discard trusted keys — preserve the bad file for diagnosis, then start
      // empty. (Silent loss would downgrade future MITM detection from
      // host_key_changed → host_key_unknown for every host.)
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
      this.cache = {};
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Atomic write: a crash mid-write must not truncate the live trust store.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.load(), null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  get(host: string, port: number): KnownHostEntry | undefined {
    return this.load()[keyOf(host, port)];
  }

  /** Record (or overwrite) a trusted key for `host:port`. */
  set(host: string, port: number, entry: Omit<KnownHostEntry, 'trustedAtMs'>): void {
    this.load()[keyOf(host, port)] = { ...entry, trustedAtMs: Date.now() };
    this.persist();
  }
}
