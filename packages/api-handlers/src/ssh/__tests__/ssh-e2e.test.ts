/**
 * End-to-end tests for the SSH connection manager against a REAL, in-process
 * `ssh2` server on loopback (no Docker, no external sshd, hermetic). Covers the
 * security-critical paths that had zero coverage: TOFU host-key trust
 * (unknown → trust → ok), changed-key rejection, connection pooling/ref-count,
 * and a real shell channel round-trip.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';
import { ApiError, type SshConnectSpec, type SshHostKeyInfo } from '@mcp/api-bus';
import { SshConnectionManager } from '../ssh-connection-manager.js';
import { KnownHostsStore } from '../known-hosts.js';
import { sshExec } from '../ssh-exec.js';

const USER = 'tester';
const PASS = 'pw';

interface Harness {
  port: number;
  close: () => Promise<void>;
}

/** Spin up a minimal password-auth ssh2 server that serves a shell + exec. */
function startSshd(): Promise<Harness> {
  const hostKey = utils.generateKeyPairSync('ed25519');
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) ctx.accept();
      else ctx.reject(['password'], false);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acc) => acc()); // grant the PTY the client requests
        session.on('shell', (acc) => {
          const stream = acc();
          stream.write('ready\r\n');
          stream.on('data', (d: Buffer) => stream.write(d)); // echo
        });
        session.on('exec', (acc, _rej, info) => {
          const stream = acc();
          stream.write(`ran:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on('error', () => undefined); // swallow teardown resets
  });
  return new Promise<Harness>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}

describe('SSH connection manager — in-process sshd E2E', () => {
  let dir: string;
  let storeFile: string;
  let manager: SshConnectionManager;
  let harness: Harness;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-e2e-'));
    storeFile = join(dir, 'known_hosts.json');
    harness = await startSshd();
    manager = new SshConnectionManager(new KnownHostsStore(storeFile));
  });
  afterEach(async () => {
    manager.disconnect('h1');
    await harness.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const spec = (): SshConnectSpec => ({
    hostId: 'h1',
    host: '127.0.0.1',
    port: harness.port,
    username: USER,
    auth: { method: 'password', password: PASS },
  });

  /** First dial to an untrusted host always rejects; returns the offered key for trust(). */
  async function offeredKey(): Promise<SshHostKeyInfo> {
    try {
      await manager.acquire(spec());
      throw new Error('expected ssh_host_key_unknown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('ssh_host_key_unknown');
      return (e as ApiError).details!.hostKey as SshHostKeyInfo;
    }
  }

  it('TOFU: an unknown host is rejected with its fingerprint', async () => {
    const info = await offeredKey();
    expect(info).toMatchObject({ host: '127.0.0.1', port: harness.port });
    expect(info.fingerprint).toMatch(/^SHA256:/);
  });

  it('TOFU: trust the offered key, then connect succeeds and pools by ref-count', async () => {
    manager.trust(await offeredKey());
    const c1 = await manager.acquire(spec());
    const c2 = await manager.acquire(spec()); // reuse → same Client
    expect(c2).toBe(c1);
    manager.release('h1');
    manager.release('h1'); // ref 0 → closes
  });

  it('trust() refuses a key that was never presented', () => {
    expect(() =>
      manager.trust({ hostId: 'h1', host: '127.0.0.1', port: harness.port, keyType: 'ssh-ed25519', fingerprint: 'SHA256:bogus' }),
    ).toThrow(ApiError);
  });

  it('shares one handshake between concurrent acquisitions and ignores a late release after reconnect', async () => {
    manager.trust(await offeredKey());
    const [first, second] = await Promise.all([manager.acquire(spec()), manager.acquire(spec())]);
    expect(first).toBe(second);
    manager.disconnect('h1');
    const replacement = await manager.acquire(spec());
    manager.release('h1', first);
    expect(await manager.acquire(spec())).toBe(replacement);
    manager.release('h1', replacement);
    manager.release('h1', replacement);
  });

  it('rejects a CHANGED host key (possible MITM)', async () => {
    // Pin a fingerprint that DIFFERS from what the server presents.
    const store = new KnownHostsStore(storeFile);
    store.set('127.0.0.1', harness.port, { fingerprint: 'SHA256:differentdifferentdifferent', keyType: 'ssh-ed25519' });
    const m2 = new SshConnectionManager(store);
    try {
      await m2.acquire(spec());
      throw new Error('expected ssh_host_key_changed');
    } catch (e) {
      expect((e as ApiError).code).toBe('ssh_host_key_changed');
    } finally {
      m2.disconnect('h1');
    }
  });

  it('opens a real shell channel over the trusted connection', async () => {
    manager.trust(await offeredKey());
    const client = await manager.acquire(spec());
    const greeting = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no shell greeting')), 4000);
      client.shell((err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        let buf = '';
        stream.on('data', (d: Buffer) => {
          buf += d.toString('utf8');
          if (buf.includes('ready')) {
            clearTimeout(timer);
            resolve(buf);
          }
        });
      });
    });
    expect(greeting).toContain('ready');
    manager.release('h1');
  });

  it('execCommand captures stdout + exit code and releases its ref (non-PTY)', async () => {
    manager.trust(await offeredKey());
    const res = await sshExec(manager, spec(), 'echo hi');
    expect(res.stdout).toContain('ran:echo hi');
    expect(res.code).toBe(0);
    expect(res.truncated).toBe(false);
    // sshExec released the ref in its finally, so a fresh acquire re-dials cleanly.
    const c = await manager.acquire(spec());
    expect(c).toBeTruthy();
    manager.release('h1');
  });
});
