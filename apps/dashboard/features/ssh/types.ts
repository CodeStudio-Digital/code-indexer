/**
 * Renderer-side mirror of the SSH store row shapes (migration 173). Kept local
 * to the feature (like api-client/types.ts) so the dashboard doesn't import the
 * Node-only `@mcp/store` package. `enc_*` fields are OS-keychain ciphertext.
 */

export type SshAuthMethod = 'password' | 'privateKey' | 'agent' | 'identity';
export type SshIdentityAuthKind = 'password' | 'privateKey' | 'agent';

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

export interface SshSnippet {
  id: number;
  project_id: number;
  name: string;
  command: string;
  created_at: string;
  updated_at: string;
}

/** What the host editor collects; secrets are plaintext here and encrypted before save. */
export interface HostFormValues {
  label: string;
  hostname: string;
  port: string;
  username: string;
  auth_method: SshAuthMethod;
  password: string;
  privateKey: string;
  passphrase: string;
  identity_id: number | null;
  jump_host_id: number | null;
  group_name: string;
  agent_forwarding: boolean;
}
