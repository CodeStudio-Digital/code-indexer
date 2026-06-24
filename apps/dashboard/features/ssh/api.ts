/**
 * Renderer client for the `ssh` namespace. Thin wrappers over `apiCall`,
 * plus the TOFU connect helper that turns a thrown `ssh_host_key_*` error
 * into a user trust decision and retries.
 */

import { apiCall, apiStream, apiBaseUrl } from '../../lib/api-client.js';
import type {
  SshAuth,
  SshConnectSpec,
  SshHostKeyInfo,
  SshOpenShellResult,
  SshTunnel,
  SshTunnelInput,
  SshGeneratedKey,
  SshConfigHost,
  SftpEntry,
  SftpProgress,
} from '@mcp/api-bus';
import type { SshHost, SshIdentity, SshSnippet, SshAuthMethod } from './types.js';

export function openShell(spec: SshConnectSpec, cols: number, rows: number): Promise<SshOpenShellResult> {
  return apiCall<SshOpenShellResult>('ssh.openShell', { spec, cols, rows });
}

export function testConnection(
  spec: SshConnectSpec,
): Promise<{ ok: true } | { ok: false; reason: string; hostKey?: SshHostKeyInfo }> {
  return apiCall('ssh.testConnection', { spec });
}

export function trustHostKey(info: SshHostKeyInfo): Promise<void> {
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

/** Open the connection's SFTP root (resolves `.` to the user's home), TOFU-aware. */
export const sftpListWithTrust = (spec: SshConnectSpec, path: string, onNeedTrust: NeedTrust) =>
  withHostKeyTrust(() => sftpList(spec, path), onNeedTrust);

// ─── Native file dialogs (Electron) ──────────────────────────────────────
function nativeDialogs(): { openFiles(): Promise<string[]>; saveFile(name?: string): Promise<string | null> } | null {
  const e = (globalThis as { electronAPI?: { openFiles?: () => Promise<string[]>; saveFile?: (n?: string) => Promise<string | null> } }).electronAPI;
  return e?.openFiles && e?.saveFile ? { openFiles: e.openFiles, saveFile: e.saveFile } : null;
}
export const pickLocalFiles = (): Promise<string[]> => nativeDialogs()?.openFiles() ?? Promise.resolve([]);
export const pickSavePath = (name?: string): Promise<string | null> => nativeDialogs()?.saveFile(name) ?? Promise.resolve(null);

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

export const listHosts = (p: number) =>
  req<{ hosts: SshHost[] }>(`${root(p)}/hosts`).then((r) => r.hosts);
export const createHost = (p: number, body: Record<string, unknown>) =>
  req<SshHost>(`${root(p)}/hosts`, j('POST', body));
export const patchHost = (p: number, hid: number, patch: Record<string, unknown>) =>
  req<SshHost>(`${root(p)}/hosts/${hid}`, j('PATCH', patch));
export const deleteHost = (p: number, hid: number) =>
  req<{ ok: true }>(`${root(p)}/hosts/${hid}`, { method: 'DELETE' });

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

export const runSnippet = (spec: SshConnectSpec, command: string) =>
  apiCall<SshOpenShellResult>('ssh.runSnippet', { spec, command, cols: 80, rows: 24 });

// ─── Secret shim (OS keychain via the Electron preload) ──────────────────

function sshSecretBridge():
  | { encryptSecret(p: string): Promise<string>; decryptSecret(b: string): Promise<string> }
  | null {
  return (
    (globalThis as { electronAPI?: { ssh?: { encryptSecret(p: string): Promise<string>; decryptSecret(b: string): Promise<string> } } })
      .electronAPI?.ssh ?? null
  );
}

/** Encrypt a secret with the OS keychain before persisting. Browser-dev fallback: passthrough. */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return '';
  const bridge = sshSecretBridge();
  return bridge ? bridge.encryptSecret(plain) : plain;
}

/** Decrypt a stored secret just before connecting. */
export async function decryptSecret(blob: string | null): Promise<string> {
  if (!blob) return '';
  const bridge = sshSecretBridge();
  return bridge ? bridge.decryptSecret(blob) : blob;
}

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
    hostId: `saved:${host.id}:jump`,
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
    hostId: `saved:${host.id}`,
    host: host.hostname,
    port: host.port,
    username: host.username,
    auth: await resolveAuth(host.auth_method, { password: host.enc_password, privateKey: host.enc_private_key, passphrase: host.enc_passphrase }, identity),
    jump: jump.length ? jump : undefined,
    keepaliveSecs: host.keepalive_secs ?? undefined,
    agentForward: !!host.agent_forwarding,
  };
}
