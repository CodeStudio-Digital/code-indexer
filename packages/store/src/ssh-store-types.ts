/**
 * Row + input types for the embedded SSH client store (migration 173).
 *
 * `enc_*` fields hold OS-keychain ciphertext (base64) produced by the
 * renderer's `safeStorage` shim — the store never sees plaintext secrets.
 */

export type SshAuthMethod = 'password' | 'privateKey' | 'agent' | 'identity';
export type SshIdentityAuthKind = 'password' | 'privateKey' | 'agent';

export interface SshIdentity {
  id: number;
  project_id: number;
  name: string;
  username: string | null;
  auth_kind: SshIdentityAuthKind;
  enc_password: string | null;
  enc_private_key: string | null;
  enc_passphrase: string | null;
  public_key: string | null;
  key_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface SshHost {
  id: number;
  project_id: number;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_method: SshAuthMethod;
  identity_id: number | null;
  enc_password: string | null;
  enc_private_key: string | null;
  enc_passphrase: string | null;
  jump_host_id: number | null;
  group_name: string | null;
  /** JSON array of tag strings. */
  tags_json: string;
  agent_forwarding: number;
  keepalive_secs: number | null;
  known_host_sha256: string | null;
  startup_snippet_id: number | null;
  last_used_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSshIdentityInput {
  project_id: number;
  name: string;
  username?: string | null;
  auth_kind: SshIdentityAuthKind;
  enc_password?: string | null;
  enc_private_key?: string | null;
  enc_passphrase?: string | null;
  public_key?: string | null;
  key_type?: string | null;
}
export type SshIdentityPatch = Partial<Omit<CreateSshIdentityInput, 'project_id'>>;

export interface SshSnippet {
  id: number;
  project_id: number;
  name: string;
  command: string;
  created_at: string;
  updated_at: string;
}
export interface CreateSshSnippetInput {
  project_id: number;
  name: string;
  command: string;
}
export type SshSnippetPatch = Partial<Omit<CreateSshSnippetInput, 'project_id'>>;

/**
 * Named secret referenced from a snippet as `${secret:name}` (migration 197).
 * `enc_value` is OS-keychain ciphertext produced by the renderer — the store
 * never sees plaintext, same as host `enc_password`.
 */
export interface SshSecret {
  id: number;
  project_id: number;
  name: string;
  enc_value: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}
export interface CreateSshSecretInput {
  project_id: number;
  name: string;
  enc_value: string;
  description?: string | null;
}
export type SshSecretPatch = Partial<Omit<CreateSshSecretInput, 'project_id'>>;

export interface CreateSshHostInput {
  project_id: number;
  label: string;
  hostname: string;
  port?: number;
  username: string;
  auth_method: SshAuthMethod;
  identity_id?: number | null;
  enc_password?: string | null;
  enc_private_key?: string | null;
  enc_passphrase?: string | null;
  jump_host_id?: number | null;
  group_name?: string | null;
  tags?: string[];
  agent_forwarding?: boolean;
  keepalive_secs?: number | null;
}
export type SshHostPatch = Partial<Omit<CreateSshHostInput, 'project_id'>>;
