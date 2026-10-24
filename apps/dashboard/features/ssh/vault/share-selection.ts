/**
 * What actually leaves this machine when you share SSH hosts with an org.
 *
 * WHY this exists: `shareWithOrg` used to take no selection at all. It called
 * `listHosts(projectId)` — which unions the project's hosts with every
 * globally-shared one — decrypted each host's password / private key /
 * passphrase, inlined the PLAINTEXT into the record, and pushed the lot under a
 * single team key granted to every org member with a published key. No
 * per-host choice, no preview of what was about to leave, no confirmation.
 *
 * This module is the pure half of the fix: the caller decides, host by host,
 * whether the host travels at all and whether its credentials travel with it.
 * Both default to OFF in the UI. Kept free of React and I/O so the rules that
 * decide what escapes are unit-testable (same shape as transfer-walk.ts).
 */
import { sshHostKey } from '../api.js';
import type { SshHost } from '../types.js';

export interface ShareChoice {
  /** Scope-qualified host key (`shared:3` / `project:3`) — see host-doc-keys.ts. */
  hostKey: string;
  /** Decrypt and publish password / private key / passphrase for this host. */
  includeCredentials: boolean;
}

/** One row in the confirmation dialog: what this host is, and what it would leak. */
export interface ShareCandidate {
  hostKey: string;
  host: SshHost;
  label: string;
  /** `user@host:port`, for the row subtitle. */
  endpoint: string;
  /** Shared across all projects — worth flagging, it isn't "this project's" host. */
  isShared: boolean;
  /** Which secret kinds this host actually holds; empty ⇒ nothing to leak. */
  secretKinds: SecretKind[];
}

export type SecretKind = 'password' | 'privateKey' | 'passphrase';

/** Which credential kinds a host actually stores (drives the per-row badges). */
export function secretKindsOf(h: SshHost): SecretKind[] {
  const kinds: SecretKind[] = [];
  if (h.enc_password) kinds.push('password');
  if (h.enc_private_key) kinds.push('privateKey');
  if (h.enc_passphrase) kinds.push('passphrase');
  return kinds;
}

/** Build the dialog rows from the project's host list. */
export function buildShareCandidates(hosts: SshHost[]): ShareCandidate[] {
  return hosts.map((host) => ({
    hostKey: sshHostKey(host),
    host,
    label: host.label,
    endpoint: `${host.username}@${host.hostname}:${host.port}`,
    isShared: !!host.is_shared,
    secretKinds: secretKindsOf(host),
  }));
}

/**
 * Resolve the selection against the CURRENT host list.
 *
 * Re-reading the list at share time is deliberate: the dialog's snapshot can be
 * stale (another window edited a host, a sync pulled a new one), and a selection
 * must never widen into a host the user never saw. Anything selected that no
 * longer exists is dropped, and a host that appeared since is NOT included.
 */
export function resolveShareSelection(hosts: SshHost[], selection: ShareChoice[]): Array<{ host: SshHost; includeCredentials: boolean }> {
  const byKey = new Map(hosts.map((h) => [sshHostKey(h), h]));
  const out: Array<{ host: SshHost; includeCredentials: boolean }> = [];
  const seen = new Set<string>();
  for (const choice of selection) {
    if (seen.has(choice.hostKey)) continue; // a duplicate must not double-publish
    seen.add(choice.hostKey);
    const host = byKey.get(choice.hostKey);
    if (!host) continue; // deleted or renamed scope since the dialog opened
    out.push({ host, includeCredentials: choice.includeCredentials });
  }
  return out;
}

interface ShareImpact {
  hosts: number;
  /** Hosts that will publish at least one decrypted secret. */
  withCredentials: number;
  /** Total individual secrets (password/key/passphrase) that would leave. */
  secrets: number;
}

/**
 * Summarize a selection for the confirm button. `withCredentials` counts only
 * hosts that BOTH opted in and actually hold a secret, so ticking "include
 * credentials" on an agent-auth host doesn't inflate the number and train the
 * user to ignore it.
 */
export function summarizeShare(candidates: ShareCandidate[], selection: ShareChoice[]): ShareImpact {
  const byKey = new Map(candidates.map((c) => [c.hostKey, c]));
  let withCredentials = 0;
  let secrets = 0;
  const seen = new Set<string>();
  for (const choice of selection) {
    if (seen.has(choice.hostKey)) continue;
    seen.add(choice.hostKey);
    const c = byKey.get(choice.hostKey);
    if (!c) continue;
    if (choice.includeCredentials && c.secretKinds.length > 0) {
      withCredentials += 1;
      secrets += c.secretKinds.length;
    }
  }
  return { hosts: seen.size, withCredentials, secrets };
}

/** SHA-256 of a base64 SPKI, as short colon-separated hex — for showing recipients. */
export async function keyFingerprint(publicSpki: string): Promise<string> {
  const bytes = Uint8Array.from(atob(publicSpki), (ch) => ch.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}
