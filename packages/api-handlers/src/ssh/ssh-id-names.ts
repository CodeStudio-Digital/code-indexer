/**
 * Resolve numeric uid/gid to account names for the SFTP pane.
 *
 * WHY this exists at all: the SFTP protocol (v3, which is what OpenSSH speaks)
 * carries ONLY numeric uid/gid in a directory listing. There is no way to get
 * "www-data" or "root" out of `readdir` — the names live in the server's passwd
 * and group databases, which have to be read separately over an exec channel.
 *
 * Cached per host, because a listing must not cost one lookup per row, and the
 * mapping is effectively static for the life of a session. `getent` is tried
 * first (it also covers LDAP/SSSD-backed directories, where /etc/passwd is
 * incomplete); the file read is the fallback for minimal containers that ship
 * no getent.
 *
 * A failure here is NOT an error: the pane simply shows the numbers, which is
 * what every SFTP client does when it can't resolve. Nothing about browsing or
 * transferring depends on it.
 */
import type { SftpIdNames, SshConnectSpec } from '@mcp/api-bus';
import type { SshConnectionManager } from './ssh-connection-manager.js';
import { sshExec } from './ssh-exec.js';

/** Lookup is best-effort and off the critical path — keep it short. */
const LOOKUP_TIMEOUT_MS = 10_000;
/** Guard against a pathological directory (very large LDAP domains). */
const MAX_ENTRIES = 20_000;

const EMPTY: SftpIdNames = { users: {}, groups: {} };

/**
 * Parse colon-separated passwd/group lines into `{ id: name }`.
 * Both formats share the shape we need: `name:x:id:...`.
 */
function parseIdMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const line of raw.split('\n')) {
    if (++n > MAX_ENTRIES) break;
    const parts = line.split(':');
    if (parts.length < 3) continue;
    const name = parts[0];
    const id = parts[2];
    // First entry wins: `getent` lists the authoritative source first, and a
    // duplicate id (common for aliases like `root`/`toor`) shouldn't flip.
    if (name && /^\d+$/.test(id) && !(id in out)) out[id] = name;
  }
  return out;
}

export class SftpIdNameResolver {
  /** hostId → resolved names. Sticky for the session; cleared on disconnect. */
  private readonly cache = new Map<string, SftpIdNames>();
  /** In-flight lookups, so N panes opening at once make ONE exec round-trip. */
  private readonly inFlight = new Map<string, Promise<SftpIdNames>>();

  constructor(private readonly manager: SshConnectionManager) {}

  async get(spec: SshConnectSpec): Promise<SftpIdNames> {
    const hit = this.cache.get(spec.hostId);
    if (hit) return hit;
    const pending = this.inFlight.get(spec.hostId);
    if (pending) return pending;

    const task = this.load(spec)
      .then((names) => {
        this.cache.set(spec.hostId, names);
        return names;
      })
      .catch(() => EMPTY) // unresolvable → show numbers, never fail the listing
      .finally(() => this.inFlight.delete(spec.hostId));

    this.inFlight.set(spec.hostId, task);
    return task;
  }

  /** Drop cached names for a host (call when its connection closes). */
  forget(hostId: string): void {
    this.cache.delete(hostId);
  }

  private async load(spec: SshConnectSpec): Promise<SftpIdNames> {
    // One exec for both databases: a second round-trip doubles the cost for a
    // lookup nobody is waiting on. `||` falls back per-database independently.
    const cmd =
      '(getent passwd || cat /etc/passwd) 2>/dev/null; ' +
      "echo '---'; " +
      '(getent group || cat /etc/group) 2>/dev/null';
    const res = await sshExec(this.manager, spec, cmd, { timeoutMs: LOOKUP_TIMEOUT_MS });
    if (res.code !== 0 && !res.stdout) return EMPTY;
    const [passwd = '', group = ''] = res.stdout.split('\n---\n');
    return { users: parseIdMap(passwd), groups: parseIdMap(group) };
  }
}

export { parseIdMap as __parseIdMapForTest };
