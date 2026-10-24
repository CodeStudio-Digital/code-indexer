/**
 * Host/identity ↔ vault-record mapping, extracted from use-ssh-vault-sync so
 * the hook stops growing (it was 800+ lines) and so the ONE place that turns a
 * sealed credential into plaintext is small enough to audit at a glance.
 *
 * Direction matters here:
 *   *ToRecord   — DECRYPTS from the OS keychain into a plaintext record that is
 *                 about to be AES-GCM sealed and uploaded.
 *   recordTo*   — re-seals with the local keychain before writing to SQLite.
 *
 * `hostToRecord` takes `includeCredentials` because the org-share path must be
 * able to publish a host as METADATA ONLY. That is the common case: a teammate
 * connecting with their own key or agent needs the hostname/user/port and
 * nothing else, so the default should move no secret at all. Passing `false`
 * means `decryptSecret` is never even called for that host.
 */
import * as api from '../api.js';
import { hostRefs } from './vault-sync-core.js';
import type { SshHost, SshIdentity } from '../types.js';

/** Plaintext host record carried in the vault (secrets decrypted from the keychain). */
export interface VaultHostRecord {
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_method: SshHost['auth_method'];
  password?: string;
  privateKey?: string;
  passphrase?: string;
  group_name: string | null;
  tags: string[];
  agent_forwarding: boolean;
  /** Shared across all projects — syncs so it stays shared on every device. */
  is_shared: boolean;
  /** Portable references (personal feed only): the referenced identity / jump host as clientDocIds. */
  identity_ref?: string | null;
  jump_host_ref?: string | null;
}

/** Plaintext identity record carried in the vault (the private key travels, sealed). */
export interface VaultIdentityRecord {
  name: string;
  username: string | null;
  auth_kind: SshIdentity['auth_kind'];
  password?: string;
  privateKey?: string;
  passphrase?: string;
  public_key: string | null;
  key_type: string | null;
}

/** Portable cross-device references, resolved by the caller (see vault-sync-core). */
interface HostRefResolvers {
  identityMap: Record<string, string>;
  jumpDocFor: (jumpId: number) => string | undefined;
}

interface HostToRecordOptions {
  /** Personal feed carries portable refs; the team feed omits them. */
  refs?: HostRefResolvers;
  /**
   * Decrypt and carry password / private key / passphrase. Defaults to TRUE for
   * the personal feed (it is a backup of your own vault, on your own key). The
   * org-share path passes it explicitly per host.
   */
  includeCredentials?: boolean;
}

function parseTags(tagsJson: string): string[] {
  try {
    return JSON.parse(tagsJson || '[]') as string[];
  } catch {
    return [];
  }
}

export async function hostToRecord(h: SshHost, opts: HostToRecordOptions = {}): Promise<VaultHostRecord> {
  const { refs, includeCredentials = true } = opts;
  const secrets = includeCredentials
    ? {
        password: h.enc_password ? await api.decryptSecret(h.enc_password) : undefined,
        privateKey: h.enc_private_key ? await api.decryptSecret(h.enc_private_key) : undefined,
        passphrase: h.enc_passphrase ? await api.decryptSecret(h.enc_passphrase) : undefined,
      }
    : {};
  return {
    label: h.label,
    hostname: h.hostname,
    port: h.port,
    username: h.username,
    // Without credentials the recipient must supply their own; `agent` is the
    // only method that works with nothing attached, so don't advertise a method
    // whose material we deliberately withheld.
    auth_method: includeCredentials ? h.auth_method : 'agent',
    ...secrets,
    group_name: h.group_name,
    tags: parseTags(h.tags_json),
    agent_forwarding: !!h.agent_forwarding,
    is_shared: !!h.is_shared,
    ...(refs ? hostRefs(h, refs.identityMap, refs.jumpDocFor) : {}),
  };
}

/**
 * Vault record → createHost/patchHost body (re-seal secrets with the OS keychain).
 * `ids` (personal feed) sets the resolved local identity_id; jump_host_id is set
 * separately AFTER all hosts exist (a deferred sweep). The team feed passes no
 * `ids`, so it never writes identity/jump links (P2 scope).
 */
export async function recordToHostBody(
  r: VaultHostRecord,
  ids?: { identity_id: number | null },
): Promise<Record<string, unknown>> {
  return {
    label: r.label,
    hostname: r.hostname,
    port: r.port,
    username: r.username,
    auth_method: r.auth_method,
    group_name: r.group_name,
    tags: r.tags,
    agent_forwarding: r.agent_forwarding,
    is_shared: r.is_shared,
    enc_password: r.password ? await api.encryptSecret(r.password) : null,
    enc_private_key: r.privateKey ? await api.encryptSecret(r.privateKey) : null,
    enc_passphrase: r.passphrase ? await api.encryptSecret(r.passphrase) : null,
    ...(ids ? { identity_id: ids.identity_id } : {}),
  };
}

export async function identityToRecord(i: SshIdentity): Promise<VaultIdentityRecord> {
  return {
    name: i.name,
    username: i.username,
    auth_kind: i.auth_kind,
    password: i.enc_password ? await api.decryptSecret(i.enc_password) : undefined,
    privateKey: i.enc_private_key ? await api.decryptSecret(i.enc_private_key) : undefined,
    passphrase: i.enc_passphrase ? await api.decryptSecret(i.enc_passphrase) : undefined,
    public_key: i.public_key,
    key_type: i.key_type,
  };
}

/** Vault identity record → createIdentity/patchIdentity body (re-seal secrets). */
export async function recordToIdentityBody(r: VaultIdentityRecord): Promise<Record<string, unknown>> {
  return {
    name: r.name,
    username: r.username,
    auth_kind: r.auth_kind,
    public_key: r.public_key,
    key_type: r.key_type,
    enc_password: r.password ? await api.encryptSecret(r.password) : null,
    enc_private_key: r.privateKey ? await api.encryptSecret(r.privateKey) : null,
    enc_passphrase: r.passphrase ? await api.encryptSecret(r.passphrase) : null,
  };
}
