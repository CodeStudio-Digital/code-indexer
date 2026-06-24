/**
 * Pooled `ssh2` connection manager — the SSH analogue of `sharedPtyManager`.
 *
 * One `ssh2.Client` per `hostId`, ref-counted across the channels opened on
 * it (shells now; SFTP sessions + tunnels in later phases), since a single
 * Client multiplexes many channels. The last channel to close drops the
 * connection.
 *
 * Host-key trust is enforced in `hostVerifier`: the key the server presents
 * is fingerprinted and checked against the TOFU store. A miss/mismatch
 * rejects the handshake; `dial` then translates the failure into a precise
 * `ApiError` (`ssh_host_key_unknown` / `ssh_host_key_changed`) carrying the
 * fingerprint so the UI can prompt for trust.
 *
 * Jump hosts (`spec.jump`, nearest-first) are chained by `forwardOut`-ing
 * from each hop's Client to the next and dialing the final host over that
 * stream (`sock`).
 */

import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
// ssh2 is CommonJS; not all of its named exports survive Node's ESM interop
// (see ssh-keys.ts). Pull the runtime `Client` value off the default import;
// types stay as erased type-only named imports.
import ssh2, { type ConnectConfig } from 'ssh2';
import { ApiError, type SshConnectSpec, type SshAuth, type SshHostKeyInfo } from '@mcp/api-bus';

const { Client } = ssh2;
type Client = InstanceType<typeof ssh2.Client>;
import { KnownHostsStore } from './known-hosts.js';

interface ManagedConnection {
  client: Client;
  refCount: number;
  /** Endpoint signature — a pooled connection is only reused if the spec still resolves to it. */
  sig: string;
}

/** Identity of where a spec actually connects (host/port/user/auth/jump chain). */
function endpointSig(spec: SshConnectSpec): string {
  const jump = (spec.jump ?? []).map((j) => `${j.host}:${j.port ?? DEFAULT_PORT}`).join('>');
  return `${spec.host}:${spec.port ?? DEFAULT_PORT}|${spec.username}|${spec.auth.method}|${jump}`;
}

const DEFAULT_PORT = 22;
const READY_TIMEOUT_MS = 20_000;
const DEFAULT_KEEPALIVE_SECS = 15;
const MAX_JUMP_DEPTH = 10;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class SshConnectionManager {
  private readonly conns = new Map<string, ManagedConnection>();
  /**
   * Host keys actually OBSERVED during a recent failed handshake, keyed by
   * `host:port`. `trust()` only accepts a fingerprint that matches a live
   * challenge here — so a compromised renderer can't pre-seed an arbitrary key
   * that was never presented (which would enable a silent later MITM).
   */
  private readonly pendingChallenges = new Map<string, { fingerprint: string; expiresAt: number }>();

  constructor(private readonly knownHosts: KnownHostsStore) {}

  /** Open or reuse the pooled connection for `spec.hostId`, bumping its ref-count. */
  async acquire(spec: SshConnectSpec): Promise<Client> {
    const sig = endpointSig(spec);
    const existing = this.conns.get(spec.hostId);
    if (existing) {
      if (existing.sig === sig) {
        existing.refCount += 1;
        return existing.client;
      }
      // The saved host was repointed (host/port/user/auth/jump changed) while a
      // connection was still pooled under the same id. Reusing it would route to
      // the OLD endpoint with no fresh host-key check — drop it and redial.
      this.conns.delete(spec.hostId);
      existing.client.end();
    }
    const client = await this.dialChain(spec);
    const managed: ManagedConnection = { client, refCount: 1, sig };
    this.conns.set(spec.hostId, managed);
    client.on('close', () => {
      // Peer/keepalive death — drop the pool entry so the next acquire redials.
      if (this.conns.get(spec.hostId) === managed) this.conns.delete(spec.hostId);
    });
    return client;
  }

  /** Drop one channel's hold; ends the connection when the last is released. */
  release(hostId: string): void {
    const managed = this.conns.get(hostId);
    if (!managed) return;
    managed.refCount -= 1;
    if (managed.refCount <= 0) {
      this.conns.delete(hostId);
      managed.client.end();
    }
  }

  /** Force-close a connection and every channel on it, regardless of ref-count. */
  disconnect(hostId: string): void {
    const managed = this.conns.get(hostId);
    if (!managed) return;
    this.conns.delete(hostId);
    managed.client.end();
  }

  /**
   * Persist a host key as trusted (TOFU) after the user accepts it — but ONLY if
   * this exact fingerprint was actually presented by `host:port` during a recent
   * failed dial. This keeps TOFU's invariant: a stored key was genuinely seen.
   */
  trust(info: SshHostKeyInfo): void {
    const key = `${info.host}:${info.port}`;
    const challenge = this.pendingChallenges.get(key);
    if (!challenge || challenge.expiresAt < Date.now() || challenge.fingerprint !== info.fingerprint) {
      throw new ApiError('ssh_host_key_not_offered', 409, 'refusing to trust a host key that was not just presented');
    }
    this.pendingChallenges.delete(key);
    this.knownHosts.set(info.host, info.port, { fingerprint: info.fingerprint, keyType: info.keyType });
  }

  private recordChallenge(host: string, port: number, fingerprint: string): void {
    this.pendingChallenges.set(`${host}:${port}`, { fingerprint, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  }

  /** Establish a connection, chaining through `spec.jump` (nearest-first) when present. */
  private async dialChain(spec: SshConnectSpec): Promise<Client> {
    if (!spec.jump || spec.jump.length === 0) {
      return this.dial(spec);
    }
    if (spec.jump.length > MAX_JUMP_DEPTH) {
      throw new ApiError('ssh_jump_too_deep', 400, 'jump-host chain exceeds maximum depth');
    }
    // ProxyJump semantics: connect to j1, forward through it to j2, … to jn,
    // then forward from jn to the final target and dial it over that stream.
    const lastJump = await this.connectChain(spec.jump);
    const sock = await forwardOut(lastJump, spec.host, spec.port ?? DEFAULT_PORT);
    return this.dial({ ...spec, jump: undefined }, sock);
  }

  /** Connect sequentially through the jump chain (nearest-first), returning the LAST hop's Client. */
  private async connectChain(jumps: SshConnectSpec[]): Promise<Client> {
    let client = await this.dial({ ...jumps[0], jump: undefined });
    for (let i = 1; i < jumps.length; i += 1) {
      const sock = await forwardOut(client, jumps[i].host, jumps[i].port ?? DEFAULT_PORT);
      client = await this.dial({ ...jumps[i], jump: undefined }, sock);
    }
    return client;
  }

  private dial(spec: SshConnectSpec, sock?: Duplex): Promise<Client> {
    const port = spec.port ?? DEFAULT_PORT;
    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      let seenKey: SshHostKeyInfo | undefined;

      client.on('ready', () => resolve(client));
      client.on('error', (err: Error) => {
        // Translate a host-key rejection into a precise, actionable error.
        if (seenKey) {
          const known = this.knownHosts.get(spec.host, port);
          // Record what we ACTUALLY saw so trust() can only ratify a real key.
          this.recordChallenge(spec.host, port, seenKey.fingerprint);
          if (!known) {
            reject(
              new ApiError('ssh_host_key_unknown', 409, `host key for ${spec.host}:${port} is not trusted yet`, {
                hostKey: seenKey,
              }),
            );
            return;
          }
          if (known.fingerprint !== seenKey.fingerprint) {
            reject(
              new ApiError(
                'ssh_host_key_changed',
                409,
                `REMOTE HOST KEY for ${spec.host}:${port} has CHANGED — possible man-in-the-middle. Connection refused.`,
                { hostKey: seenKey },
              ),
            );
            return;
          }
        }
        reject(new ApiError('ssh_connect_failed', 502, err.message));
      });

      const config: ConnectConfig = {
        host: spec.host,
        port,
        username: spec.username,
        ...authConfig(spec.auth),
        sock,
        agentForward: spec.agentForward,
        keepaliveInterval: (spec.keepaliveSecs ?? DEFAULT_KEEPALIVE_SECS) * 1000,
        keepaliveCountMax: 3,
        readyTimeout: READY_TIMEOUT_MS,
        hostVerifier: ((keyBuf: Buffer, verify: (valid: boolean) => void): void => {
          const info = hostKeyInfo(spec.hostId, spec.host, port, keyBuf);
          seenKey = info;
          const known = this.knownHosts.get(spec.host, port);
          verify(!!known && known.fingerprint === info.fingerprint);
        }) as ConnectConfig['hostVerifier'],
      };
      client.connect(config);
    });
  }
}

/** Map our auth union onto ssh2's connect options. */
function authConfig(auth: SshAuth): Partial<ConnectConfig> {
  switch (auth.method) {
    case 'password':
      return { password: auth.password };
    case 'privateKey':
      return { privateKey: auth.privateKey, passphrase: auth.passphrase };
    case 'agent': {
      const agent = defaultAgent();
      if (!agent) throw new ApiError('ssh_agent_unavailable', 400, 'no SSH agent available (SSH_AUTH_SOCK is unset)');
      return { agent };
    }
  }
}

/** The OS SSH agent endpoint for the current platform. */
function defaultAgent(): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return process.env.SSH_AUTH_SOCK ?? '';
}

/** Open a forwarded TCP stream from `client` to `host:port` (jump-host hop). */
function forwardOut(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) reject(new ApiError('ssh_jump_failed', 502, `jump-host forward to ${host}:${port} failed: ${err.message}`));
      else resolve(stream);
    });
  });
}

/** Compute the OpenSSH-form fingerprint + algorithm for a raw host key buffer. */
function hostKeyInfo(hostId: string, host: string, port: number, keyBuf: Buffer): SshHostKeyInfo {
  const fingerprint = 'SHA256:' + createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
  return { hostId, host, port, keyType: sshKeyAlgo(keyBuf), fingerprint };
}

/** Read the algorithm name from the SSH wire format (length-prefixed first field). */
function sshKeyAlgo(keyBuf: Buffer): string {
  try {
    const len = keyBuf.readUInt32BE(0);
    return keyBuf.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}
