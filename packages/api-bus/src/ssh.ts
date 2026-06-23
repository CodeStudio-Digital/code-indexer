/**
 * Embedded SSH client (Termius-style) — the `ssh` namespace.
 *
 * The transport is `ssh2` (pure JS), running in the Electron main process
 * alongside the shared PTY manager. The key design move: an SSH *shell
 * channel* is adapted to the `IPty` interface and registered into the SAME
 * `sharedPtyManager` as local terminals. So once `openShell` returns a
 * `terminalId`, the renderer streams/writes/resizes/kills it through the
 * EXISTING `terminal.*` API — no SSH-specific terminal plumbing in the UI.
 *
 * Host-key trust is TOFU (trust-on-first-use): a connection to an unknown
 * host is REJECTED with `ssh_host_key_unknown` (fingerprint in the error
 * details); the UI shows a trust prompt and, on accept, calls
 * `trustHostKey` then retries. A changed key is REJECTED hard with
 * `ssh_host_key_changed` (a possible MITM) and never auto-trusted.
 *
 * Connections are pooled per `hostId` and ref-counted across shells (and,
 * in later phases, SFTP sessions + tunnels) since one `ssh2.Client`
 * multiplexes many channels.
 */

import type { ApiContext, AsyncStream } from './common.js';

/** How to authenticate to a host. Secrets travel in-process only (main↔renderer IPC). */
export type SshAuth =
  | { method: 'password'; password: string }
  | { method: 'privateKey'; privateKey: string; passphrase?: string }
  /** Use the OS SSH agent (SSH_AUTH_SOCK / Windows OpenSSH agent pipe). */
  | { method: 'agent' };

/**
 * Everything needed to open a connection. For a SAVED host the renderer
 * resolves this from the SshStore (decrypting secrets via the safeStorage
 * shim) before calling; for an UNSAVED host (the edit dialog's "Connect"
 * button) it's built straight from the form with an ephemeral `hostId`.
 */
export interface SshConnectSpec {
  /** Stable id for connection pooling + known_hosts keying. Ephemeral (e.g. `draft:<uuid>`) for unsaved hosts. */
  hostId: string;
  host: string;
  /** Default 22. */
  port?: number;
  username: string;
  auth: SshAuth;
  /** Jump-host chain, nearest-first (each a fully resolved spec). The final hop is `host`. */
  jump?: SshConnectSpec[];
  /** Keepalive interval in seconds (default 15). */
  keepaliveSecs?: number;
  /** Forward the OS SSH agent to the remote (for onward auth). */
  agentForward?: boolean;
}

export interface SshOpenShellInput {
  spec: SshConnectSpec;
  /** Terminal columns. Default 80. */
  cols?: number;
  /** Terminal rows. Default 24. */
  rows?: number;
}

export interface SshOpenShellResult {
  /** A terminalId in the shared PTY manager — stream it via `terminal.output`. */
  terminalId: string;
  pid: number;
}

/** Identifies a host key the user is being asked to trust (or that changed). */
export interface SshHostKeyInfo {
  hostId: string;
  host: string;
  port: number;
  /** e.g. `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`. */
  keyType: string;
  /** SHA-256 fingerprint, OpenSSH form: `SHA256:<base64nopad>`. */
  fingerprint: string;
}

export interface SshApi {
  /**
   * Open an interactive shell over SSH and register it in the shared PTY
   * manager. Stream the returned `terminalId` via `terminal.output`.
   *
   * Throws `ssh_host_key_unknown` / `ssh_host_key_changed` (fingerprint in
   * `details`) when the host key isn't trusted — see the TOFU flow above.
   */
  openShell(input: SshOpenShellInput, ctx: ApiContext): Promise<SshOpenShellResult>;

  /**
   * Connect, authenticate, and immediately disconnect — a pre-flight check
   * for the host editor. Same host-key semantics as `openShell`; returns a
   * reason string instead of throwing for ordinary auth/network failures.
   */
  testConnection(
    input: { spec: SshConnectSpec },
    ctx: ApiContext,
  ): Promise<{ ok: true } | { ok: false; reason: string; hostKey?: SshHostKeyInfo }>;

  /**
   * Persist a host key as trusted (TOFU) after the user accepts it. Keyed by
   * `host:port`. Subsequent connections to that endpoint succeed silently
   * until the key changes.
   */
  trustHostKey(input: SshHostKeyInfo, ctx: ApiContext): Promise<void>;

  /** Drop a pooled connection and every channel on it (called when the last tab closes). */
  disconnect(input: { hostId: string }, ctx: ApiContext): Promise<void>;

  /**
   * Run a one-shot command on the host (PTY-backed `exec`) and register the
   * output as a terminal in the shared PTY manager — streamed via
   * `terminal.output` like a shell. Used for saved snippets.
   */
  runSnippet(
    input: { spec: SshConnectSpec; command: string; cols?: number; rows?: number },
    ctx: ApiContext,
  ): Promise<SshOpenShellResult>;

  /** Start a port forward over the host's pooled connection. */
  tunnelStart(input: SshTunnelInput, ctx: ApiContext): Promise<SshTunnel>;
  /** Stop a forward and release its hold on the connection. */
  tunnelStop(input: { tunnelId: string }, ctx: ApiContext): Promise<void>;
  /** List active forwards (across all hosts). */
  tunnelList(input: Record<string, never>, ctx: ApiContext): Promise<SshTunnel[]>;

  // ─── SFTP (remote file browser + transfers) ─────────────────────────────
  /** Resolve a path to absolute (expands `.`/`~`), e.g. the user's home on connect. */
  sftpRealpath(input: { spec: SshConnectSpec; path: string }, ctx: ApiContext): Promise<string>;
  /** List a remote directory. */
  sftpList(input: { spec: SshConnectSpec; path: string }, ctx: ApiContext): Promise<SftpEntry[]>;
  sftpMkdir(input: { spec: SshConnectSpec; path: string }, ctx: ApiContext): Promise<void>;
  sftpRename(input: { spec: SshConnectSpec; from: string; to: string }, ctx: ApiContext): Promise<void>;
  sftpRemove(input: { spec: SshConnectSpec; path: string; isDir: boolean }, ctx: ApiContext): Promise<void>;
  /** Close the cached SFTP session for a host (releases its hold on the connection). */
  sftpClose(input: { hostId: string }, ctx: ApiContext): Promise<void>;
  /** Download a remote file to a local path; streams transfer progress. */
  sftpDownloadStream(
    input: { spec: SshConnectSpec; remotePath: string; localPath: string },
    ctx: ApiContext,
  ): AsyncStream<SftpProgress>;
  /** Upload a local file to a remote path; streams transfer progress. */
  sftpUploadStream(
    input: { spec: SshConnectSpec; localPath: string; remotePath: string },
    ctx: ApiContext,
  ): AsyncStream<SftpProgress>;

  /**
   * Read a SMALL remote text file into memory for in-editor editing (the
   * SFTP "edit" pencil opens the result in a Monaco tab). Refuses directories
   * (`sftp_is_directory`), oversized files (`sftp_file_too_large`, ~2 MB cap)
   * and binary content (`sftp_binary_file`) — those belong in the streaming
   * download path, not the editor.
   */
  sftpReadFile(
    input: { spec: SshConnectSpec; remotePath: string },
    ctx: ApiContext,
  ): Promise<SftpReadFileResult>;
  /** Overwrite a remote file with UTF-8 text — the in-editor save. Returns the new byte length. */
  sftpWriteFile(
    input: { spec: SshConnectSpec; remotePath: string; content: string },
    ctx: ApiContext,
  ): Promise<{ size: number }>;
}

export interface SftpReadFileResult {
  /** Decoded UTF-8 text content. */
  content: string;
  /** Byte length on the wire. */
  size: number;
}

export interface SftpEntry {
  name: string;
  /** Absolute remote path. */
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  /** Modified time, epoch ms. */
  mtime: number;
  /** Unix permission bits. */
  mode: number;
}

export type SftpProgress =
  | { type: 'progress'; transferred: number; total: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type SshTunnelKind =
  /** local: listen locally, forward each connection to dest via the remote. */
  | 'local'
  /** remote: ask the remote to listen, forward each connection back to a local dest. */
  | 'remote'
  /** dynamic: a local SOCKS5 proxy whose connections egress through the remote. */
  | 'dynamic';

export interface SshTunnelInput {
  /** How to reach the host (the tunnel rides this pooled connection). */
  spec: SshConnectSpec;
  kind: SshTunnelKind;
  /** Bind address for the listener. Default 127.0.0.1. */
  bindHost?: string;
  /** Local listen port (local/dynamic) or the remote bind port (remote). */
  bindPort: number;
  /** Destination host — required for local/remote, ignored for dynamic. */
  destHost?: string;
  destPort?: number;
}

export interface SshTunnel {
  id: string;
  hostId: string;
  kind: SshTunnelKind;
  bindHost: string;
  bindPort: number;
  destHost?: string;
  destPort?: number;
  /** Bytes sent through the listener side since start. */
  bytesUp: number;
  bytesDown: number;
}
