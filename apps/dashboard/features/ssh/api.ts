/**
 * Renderer client for the `ssh` namespace. Thin wrappers over `apiCall`,
 * plus the TOFU connect helper that turns a thrown `ssh_host_key_*` error
 * into a user trust decision and retries.
 */

import { apiCall, apiStream, apiBaseUrl } from '../../lib/api-client.js';
import { encryptSecret, decryptSecret } from '@mcp/secret-box';
import type {
  SshAuth,
  SshConnectSpec,
  SshHostKeyInfo,
  SshOpenShellResult,
  SshTunnel,
  SshTunnelInput,
  SshGeneratedKey,
  SshConfigHost,
  SshExecResult,
  SftpEntry,
  SftpIdNames,
  SftpProgress,
} from '@mcp/api-bus';
import type { SshHost, SshIdentity, SshSnippet, SshSecret, SshAuthMethod, SshHostStorageScope } from './types.js';

function openShell(spec: SshConnectSpec, cols: number, rows: number): Promise<SshOpenShellResult> {
  return apiCall<SshOpenShellResult>('ssh.openShell', { spec, cols, rows });
}

export function testConnection(
  spec: SshConnectSpec,
): Promise<{ ok: true } | { ok: false; reason: string; hostKey?: SshHostKeyInfo }> {
  return apiCall('ssh.testConnection', { spec });
}

function trustHostKey(info: SshHostKeyInfo): Promise<void> {
  return apiCall<void>('ssh.trustHostKey', info);
}

// ─── Port forwarding ─────────────────────────────────────────────────────
export const tunnelStart = (input: SshTunnelInput) => apiCall<SshTunnel>('ssh.tunnelStart', input);
export const tunnelStop = (tunnelId: string) => apiCall<void>('ssh.tunnelStop', { tunnelId });
export const tunnelList = () => apiCall<SshTunnel[]>('ssh.tunnelList', {});

// ─── SFTP ─────────────────────────────────────────────────────────────────
export const sftpRealpath = (spec: SshConnectSpec, path: string) =>
  apiCall<string>('ssh.sftpRealpath', { spec, path });
export const sftpList = (spec: SshConnectSpec, path: string) => apiCall<SftpEntry[]>('ssh.sftpList', { spec, path });
export const sftpMkdir = (spec: SshConnectSpec, path: string) => apiCall<void>('ssh.sftpMkdir', { spec, path });
export const sftpRename = (spec: SshConnectSpec, from: string, to: string) =>
  apiCall<void>('ssh.sftpRename', { spec, from, to });
export const sftpRemove = (spec: SshConnectSpec, path: string, isDir: boolean) =>
  apiCall<void>('ssh.sftpRemove', { spec, path, isDir });
export const sftpClose = (hostId: string) => apiCall<void>('ssh.sftpClose', { hostId });
export const sftpDownload = (spec: SshConnectSpec, remotePath: string, localPath: string, transferId: string) =>
  apiStream<SftpProgress>('ssh.sftpDownloadStream', { spec, remotePath, localPath, transferId });
export const sftpUpload = (spec: SshConnectSpec, localPath: string, remotePath: string, transferId: string) =>
  apiStream<SftpProgress>('ssh.sftpUploadStream', { spec, localPath, remotePath, transferId });
export const sftpCancel = (transferId: string) => apiCall<void>('ssh.sftpCancel', { transferId });
export const sftpReadFile = (spec: SshConnectSpec, remotePath: string) =>
  apiCall<{ content: string; size: number }>('ssh.sftpReadFile', { spec, remotePath });
export const generateKey = (input: { type?: 'ed25519' | 'rsa'; bits?: number; comment?: string; passphrase?: string }) =>
  apiCall<SshGeneratedKey>('ssh.generateKey', input);
export const importSshConfig = () => apiCall<SshConfigHost[]>('ssh.importSshConfig', {});
export const sftpWriteFile = (spec: SshConnectSpec, remotePath: string, content: string) =>
  apiCall<{ size: number }>('ssh.sftpWriteFile', { spec, remotePath, content });

/** Run a command on the host and wait for the result (non-PTY). Used for remote zip/tar. */
export const execCommand = (
  spec: SshConnectSpec,
  command: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
) => apiCall<SshExecResult>('ssh.execCommand', { spec, command, ...opts });

/** Open the connection's SFTP root (resolves `.` to the user's home), TOFU-aware. */
export const sftpChmod = (spec: SshConnectSpec, path: string, mode: number, recursive = false) =>
  apiCall<void>('ssh.sftpChmod', { spec, path, mode, recursive });

export const sftpChown = (spec: SshConnectSpec, path: string, uid: number, gid: number, recursive = false) =>
  apiCall<void>('ssh.sftpChown', { spec, path, uid, gid, recursive });

/** uid/gid → name maps for a host (cached in main; empty when unresolvable). */
export const sftpIdNames = (spec: SshConnectSpec) => apiCall<SftpIdNames>('ssh.sftpIdNames', { spec });

export const sftpListWithTrust = (spec: SshConnectSpec, path: string, onNeedTrust: NeedTrust) =>
  withHostKeyTrust(() => sftpList(spec, path), onNeedTrust);

// ─── Native file dialogs (Electron) ──────────────────────────────────────
function nativeDialogs(): { openFiles(): Promise<string[]>; saveFile(name?: string): Promise<string | null> } | null {
  const e = (globalThis as { electronAPI?: { openFiles?: () => Promise<string[]>; saveFile?: (n?: string) => Promise<string | null> } }).electronAPI;
  return e?.openFiles && e?.saveFile ? { openFiles: e.openFiles, saveFile: e.saveFile } : null;
}
const pickLocalFiles = (): Promise<string[]> => nativeDialogs()?.openFiles() ?? Promise.resolve([]);
const pickSavePath = (name?: string): Promise<string | null> => nativeDialogs()?.saveFile(name) ?? Promise.resolve(null);

/** A pending host-key trust decision surfaced to the UI. */
export type HostKeyDecision = 'unknown' | 'changed';

export type NeedTrust = (hostKey: SshHostKeyInfo, mode: HostKeyDecision) => Promise<boolean>;

/**
 * Run an SSH `attempt` that may fail on an untrusted/changed host key; if so,
 * surface the decision via `onNeedTrust`, persist on accept (TOFU), and retry.
 * Shared by shell-open and snippet-run.
 */
async function withHostKeyTrust<T>(attempt: () => Promise<T>, onNeedTrust: NeedTrust): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    const e = err as Error & { code?: string; details?: { hostKey?: SshHostKeyInfo } };
    const mode: HostKeyDecision | null =
      e.code === 'ssh_host_key_unknown' ? 'unknown' : e.code === 'ssh_host_key_changed' ? 'changed' : null;
    if (!mode || !e.details?.hostKey) throw err;
    const accepted = await onNeedTrust(e.details.hostKey, mode);
    if (!accepted) throw err;
    await trustHostKey(e.details.hostKey);
    return attempt(); // retry now-trusted
  }
}

export const connectWithTrust = (
  spec: SshConnectSpec,
  cols: number,
  rows: number,
  onNeedTrust: NeedTrust,
): Promise<SshOpenShellResult> => withHostKeyTrust(() => openShell(spec, cols, rows), onNeedTrust);

export const runSnippetWithTrust = (
  spec: SshConnectSpec,
  command: string,
  onNeedTrust: NeedTrust,
): Promise<SshOpenShellResult> => withHostKeyTrust(() => runSnippet(spec, command), onNeedTrust);

// ─── Saved hosts + identities (HTTP CRUD, migration 173) ─────────────────

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* keep status */
    }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

const root = (projectId: number) => `/api/projects/${projectId}/ssh`;
const j = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

type SshHostRouteRef = number | Pick<SshHost, 'id' | 'is_shared' | 'storage_scope'>;

function sshHostScope(host: Pick<SshHost, 'is_shared' | 'storage_scope'>): SshHostStorageScope {
  return host.storage_scope ?? (host.is_shared ? 'shared' : 'project');
}

export function sshHostKey(host: Pick<SshHost, 'id' | 'is_shared' | 'storage_scope'>): string {
  return `${sshHostScope(host)}:${host.id}`;
}

/** Local row ids can repeat in independent project databases. */
export function savedConnectionId(host: SshHost): string {
  return sshHostScope(host) === 'shared' ? `saved:shared:${host.id}` : `saved:project:${host.project_id}:${host.id}`;
}

export function findHostByKey(hosts: SshHost[], key: string): SshHost | undefined {
  return hosts.find((h) => sshHostKey(h) === key);
}

function hostRefId(ref: SshHostRouteRef): number {
  return typeof ref === 'number' ? ref : ref.id;
}

function hostRefScope(ref: SshHostRouteRef): SshHostStorageScope | undefined {
  return typeof ref === 'number' ? undefined : sshHostScope(ref);
}

function scopeQuery(scope?: SshHostStorageScope): string {
  return scope ? `?scope=${encodeURIComponent(scope)}` : '';
}

export const listHosts = (p: number) =>
  req<{ hosts: SshHost[] }>(`${root(p)}/hosts`).then((r) => r.hosts);
export const createHost = (p: number, body: Record<string, unknown>) =>
  req<SshHost>(`${root(p)}/hosts`, j('POST', body));
export const patchHost = (p: number, host: SshHostRouteRef, patch: Record<string, unknown>, scope?: SshHostStorageScope) =>
  req<SshHost>(`${root(p)}/hosts/${hostRefId(host)}${scopeQuery(scope ?? hostRefScope(host))}`, j('PATCH', patch));
export const deleteHost = (p: number, host: SshHostRouteRef, scope?: SshHostStorageScope) =>
  req<{ ok: true }>(`${root(p)}/hosts/${hostRefId(host)}${scopeQuery(scope ?? hostRefScope(host))}`, { method: 'DELETE' });

export const listIdentities = (p: number) =>
  req<{ identities: SshIdentity[] }>(`${root(p)}/identities`).then((r) => r.identities);
export const createIdentity = (p: number, body: Record<string, unknown>) =>
  req<SshIdentity>(`${root(p)}/identities`, j('POST', body));
export const patchIdentity = (p: number, iid: number, patch: Record<string, unknown>) =>
  req<SshIdentity>(`${root(p)}/identities/${iid}`, j('PATCH', patch));
export const deleteIdentity = (p: number, iid: number) =>
  req<{ ok: true }>(`${root(p)}/identities/${iid}`, { method: 'DELETE' });

export const listSnippets = (p: number) =>
  req<{ snippets: SshSnippet[] }>(`${root(p)}/snippets`).then((r) => r.snippets);
export const createSnippet = (p: number, name: string, command: string) =>
  req<SshSnippet>(`${root(p)}/snippets`, j('POST', { name, command }));
export const patchSnippet = (p: number, sid: number, patch: { name?: string; command?: string }) =>
  req<SshSnippet>(`${root(p)}/snippets/${sid}`, j('PATCH', patch));
export const deleteSnippet = (p: number, sid: number) =>
  req<{ ok: true }>(`${root(p)}/snippets/${sid}`, { method: 'DELETE' });

const runSnippet = (spec: SshConnectSpec, command: string) =>
  apiCall<SshOpenShellResult>('ssh.runSnippet', { spec, command, cols: 80, rows: 24 });

// ─── Named secrets referenced from snippets as ${secret:NAME} (migration 197) ─

/** Matches `${secret:NAME}` — namespaced so it never collides with shell `${HOME}`. */
const SECRET_REF = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;

export const listSecrets = (p: number) =>
  req<{ secrets: SshSecret[] }>(`${root(p)}/secrets`).then((r) => r.secrets);

/** Encrypt the value with the OS keychain BEFORE it leaves the renderer. */
export const createSecret = async (p: number, name: string, value: string, description?: string) =>
  req<SshSecret>(`${root(p)}/secrets`, j('POST', { name, enc_value: await encryptSecret(value), description }));

/** `value === undefined` leaves the stored secret untouched (rename/desc-only edit). */
export const patchSecret = async (
  p: number,
  secId: number,
  patch: { name?: string; value?: string; description?: string | null },
) => {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.value !== undefined) body.enc_value = await encryptSecret(patch.value);
  return req<SshSecret>(`${root(p)}/secrets/${secId}`, j('PATCH', body));
};

export const deleteSecret = (p: number, secId: number) =>
  req<{ ok: true }>(`${root(p)}/secrets/${secId}`, { method: 'DELETE' });

/**
 * Substitute every `${secret:NAME}` in a snippet command with its decrypted
 * value, just before running. Decryption uses the OS keychain in-process; the
 * resolved plaintext never touches disk. Throws (listing the missing names) if
 * any referenced secret is not defined — we never silently substitute empty,
 * which would run e.g. `git pull https://@github…`. A command with no
 * placeholder is returned untouched (no lookup, zero cost).
 */
export async function resolveSnippetCommand(projectId: number, command: string): Promise<string> {
  const names = [...command.matchAll(SECRET_REF)].map((m) => m[1]);
  if (names.length === 0) return command;

  const byName = new Map(( await listSecrets(projectId)).map((s) => [s.name, s]));
  const missing = [...new Set(names)].filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`Segredo(s) não definido(s): ${missing.join(', ')}`);

  // Decrypt each referenced secret once, then substitute all occurrences.
  const values = new Map<string, string>();
  for (const n of new Set(names)) values.set(n, await decryptSecret(byName.get(n)!.enc_value));
  return command.replace(SECRET_REF, (_full, name: string) => values.get(name) ?? _full);
}

// ─── Secret shim (OS keychain via the Electron preload) ──────────────────

// Delegated to @mcp/secret-box, the shared device-bound primitive the DB client
// already uses. This file used to carry its own copy that read ONLY the legacy
// `electronAPI.ssh` bridge and silently passed plaintext through when it was
// absent — so running the dashboard under `vite dev` wrote raw passwords and
// private keys into `ssh_hosts.enc_password`, a column whose whole contract is
// "ciphertext". secret-box reads both bridges and now refuses to store an
// unencrypted credential. Re-exported here so callers keep one import site.
export { encryptSecret, decryptSecret } from '@mcp/secret-box';

// ─── Build a live connect spec from a saved host ─────────────────────────

async function resolveAuth(
  method: SshAuthMethod,
  enc: { password: string | null; privateKey: string | null; passphrase: string | null },
  identity: SshIdentity | null,
): Promise<SshAuth> {
  if (method === 'identity' && identity) {
    return resolveAuth(identity.auth_kind, {
      password: identity.enc_password,
      privateKey: identity.enc_private_key,
      passphrase: identity.enc_passphrase,
    }, null);
  }
  if (method === 'password') return { method: 'password', password: await decryptSecret(enc.password) };
  if (method === 'privateKey') {
    return {
      method: 'privateKey',
      privateKey: await decryptSecret(enc.privateKey),
      passphrase: enc.passphrase ? await decryptSecret(enc.passphrase) : undefined,
    };
  }
  return { method: 'agent' };
}

/** A jump host as a flat spec (no nested jump — the chain is flattened by the caller). */
async function jumpSpec(host: SshHost, identities: SshIdentity[]): Promise<SshConnectSpec> {
  const identity = host.identity_id != null ? identities.find((i) => i.id === host.identity_id) ?? null : null;
  return {
    hostId: `${savedConnectionId(host)}:jump`,
    host: host.hostname,
    port: host.port,
    username: host.username,
    auth: await resolveAuth(host.auth_method, { password: host.enc_password, privateKey: host.enc_private_key, passphrase: host.enc_passphrase }, identity),
  };
}

/**
 * Build the live `SshConnectSpec` for a saved host: decrypts its secrets (and
 * its identity's), and flattens the `jump_host_id` chain into the nearest-first
 * `jump` array the connection manager expects.
 */
export async function resolveSpecFromHost(
  host: SshHost,
  allHosts: SshHost[],
  identities: SshIdentity[],
): Promise<SshConnectSpec> {
  const identity = host.identity_id != null ? identities.find((i) => i.id === host.identity_id) ?? null : null;

  // Walk jump_host_id (each points at the hop CLOSER to the target), then
  // reverse → nearest-first (the first hop we actually dial).
  const farthestFirst: SshHost[] = [];
  const seen = new Set<number>([host.id]);
  let jid = host.jump_host_id;
  while (jid != null && !seen.has(jid)) {
    seen.add(jid);
    const jh = allHosts.find((h) => h.id === jid);
    if (!jh) break;
    farthestFirst.push(jh);
    jid = jh.jump_host_id;
  }
  const jump = await Promise.all(farthestFirst.reverse().map((jh) => jumpSpec(jh, identities)));

  return {
    hostId: savedConnectionId(host),
    host: host.hostname,
    port: host.port,
    username: host.username,
    auth: await resolveAuth(host.auth_method, { password: host.enc_password, privateKey: host.enc_private_key, passphrase: host.enc_passphrase }, identity),
    jump: jump.length ? jump : undefined,
    keepaliveSecs: host.keepalive_secs ?? undefined,
    agentForward: !!host.agent_forwarding,
  };
}
