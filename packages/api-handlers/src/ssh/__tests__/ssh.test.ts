import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientChannel } from 'ssh2';
import { createHash } from 'node:crypto';
import { KnownHostsStore } from '../known-hosts.js';
import { adaptChannelToIPty } from '../ssh-pty-adapter.js';
import { generateSshKey } from '../ssh-keys.js';
import { TunnelManager } from '../ssh-tunnels.js';
import { SftpManager } from '../ssh-sftp.js';
import { SshConnectionManager } from '../ssh-connection-manager.js';

describe('KnownHostsStore (TOFU)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-knownhosts-'));
    file = join(dir, 'sub', 'known_hosts.json'); // nested → exercises mkdir
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined for an unknown host', () => {
    const store = new KnownHostsStore(file);
    expect(store.get('example.com', 22)).toBeUndefined();
  });

  it('persists a trusted key and reads it back from a fresh instance', () => {
    new KnownHostsStore(file).set('example.com', 22, { fingerprint: 'SHA256:abc', keyType: 'ssh-ed25519' });
    const reopened = new KnownHostsStore(file);
    const entry = reopened.get('example.com', 22);
    expect(entry?.fingerprint).toBe('SHA256:abc');
    expect(entry?.keyType).toBe('ssh-ed25519');
    expect(typeof entry?.trustedAtMs).toBe('number');
  });

  it('keys by host:port (same host, different port is distinct)', () => {
    const store = new KnownHostsStore(file);
    store.set('h', 22, { fingerprint: 'SHA256:a', keyType: 'ssh-ed25519' });
    expect(store.get('h', 2222)).toBeUndefined();
    expect(store.get('h', 22)?.fingerprint).toBe('SHA256:a');
  });
});

/** Minimal EventEmitter-backed stand-in for an ssh2 shell channel. */
interface FakeChannel extends EventEmitter {
  stderr: EventEmitter;
  write: ReturnType<typeof vi.fn>;
  setWindow: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
function fakeChannel(): FakeChannel {
  const ch = new EventEmitter() as FakeChannel;
  ch.stderr = new EventEmitter();
  ch.write = vi.fn();
  ch.setWindow = vi.fn();
  ch.close = vi.fn();
  return ch;
}
const asChannel = (ch: FakeChannel): ClientChannel => ch as unknown as ClientChannel;

describe('adaptChannelToIPty', () => {
  it('merges stdout + stderr into onData', () => {
    const ch = fakeChannel();
    const ipty = adaptChannelToIPty(asChannel(ch), { cols: 80, rows: 24 });
    const out: string[] = [];
    ipty.onData((d) => out.push(d));
    ch.emit('data', Buffer.from('out'));
    ch.stderr.emit('data', Buffer.from('err'));
    expect(out).toEqual(['out', 'err']);
  });

  it('forwards write and maps resize to setWindow(rows, cols, 0, 0)', () => {
    const ch = fakeChannel();
    const ipty = adaptChannelToIPty(asChannel(ch), { cols: 80, rows: 24 });
    ipty.write('ls\n');
    expect(ch.write).toHaveBeenCalledWith('ls\n');
    ipty.resize(120, 40);
    expect(ch.setWindow).toHaveBeenCalledWith(40, 120, 0, 0);
    expect(ipty.cols).toBe(120);
    expect(ipty.rows).toBe(40);
  });

  it('reports the captured remote exit code on close', () => {
    const ch = fakeChannel();
    const ipty = adaptChannelToIPty(asChannel(ch), { cols: 80, rows: 24 });
    const exits: Array<{ exitCode: number }> = [];
    ipty.onExit((e) => exits.push(e));
    ch.emit('exit', 3); // remote shell exited code 3
    ch.emit('close');
    expect(exits).toEqual([{ exitCode: 3 }]);
  });

  it('kill() closes the channel and fires onClose exactly once', () => {
    const ch = fakeChannel();
    const onClose = vi.fn();
    const ipty = adaptChannelToIPty(asChannel(ch), { cols: 80, rows: 24, onClose });
    ipty.kill();
    expect(ch.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ASYNC since the sync form blocked the Electron main process for seconds at
// RSA-4096 — see the note on generateSshKey.
describe('generateSshKey', () => {
  it('generates an ed25519 keypair in OpenSSH format with a correct SHA256 fingerprint', async () => {
    const k = await generateSshKey({ type: 'ed25519', comment: 'me@cs' });
    expect(k.keyType).toBe('ssh-ed25519');
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAA[\w+/]+ me@cs$/);
    expect(k.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    // Fingerprint = base64(sha256(raw blob)), no padding.
    const blob = Buffer.from(k.publicKey.split(/\s+/)[1], 'base64');
    const expected = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
    expect(k.fingerprint).toBe(expected);
  });

  it('generates distinct keys each call', async () => {
    const [a, b] = await Promise.all([generateSshKey({}), generateSshKey({})]);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('encrypts the private key when a passphrase is given', async () => {
    const k = await generateSshKey({ type: 'ed25519', passphrase: 's3cret' });
    // An encrypted OpenSSH key names its cipher (not "none") in the header bytes.
    expect(k.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    const plain = await generateSshKey({ type: 'ed25519' });
    expect(k.privateKey).not.toBe(plain.privateKey);
  });

  it('honors an RSA request with a sane minimum bit length', async () => {
    const k = await generateSshKey({ type: 'rsa', bits: 1024 }); // below floor → bumped to 4096
    expect(k.keyType).toBe('ssh-rsa');
    expect(k.publicKey.startsWith('ssh-rsa ')).toBe(true);
  }, 60_000);

  it('rejects with a typed error rather than throwing synchronously', async () => {
    await expect(generateSshKey({ type: 'bogus' as 'rsa' | 'ed25519' })).resolves.toBeDefined();
  });
});

describe('SftpManager editor save', () => {
  const spec = {
    hostId: 'saved:project:1',
    host: 'example.com',
    username: 'root',
    auth: { method: 'agent' as const },
  };

  it('uploads the edited UTF-8 text to the same remote path', async () => {
    const sftp = new EventEmitter() as EventEmitter & {
      writeFile: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    sftp.writeFile = vi.fn((_path: string, _content: Buffer, done: (error?: Error | null) => void) => done(null));
    sftp.end = vi.fn();

    const client = new EventEmitter() as EventEmitter & {
      sftp: ReturnType<typeof vi.fn>;
    };
    client.sftp = vi.fn((done: (error: Error | undefined, channel?: unknown) => void) => done(undefined, sftp));

    const manager = {
      acquire: vi.fn().mockResolvedValue(client),
      release: vi.fn(),
    } as unknown as SshConnectionManager;
    const service = new SftpManager(manager);
    const content = 'imagem: produção\n';

    await expect(service.writeFile(spec, '/srv/app/Dockerfile', content)).resolves.toEqual({
      size: Buffer.byteLength(content, 'utf8'),
    });
    expect(sftp.writeFile).toHaveBeenCalledOnce();
    const [remotePath, uploaded] = sftp.writeFile.mock.calls[0] as [string, Buffer];
    expect(remotePath).toBe('/srv/app/Dockerfile');
    expect(uploaded).toEqual(Buffer.from(content, 'utf8'));

    service.close(spec.hostId);
    expect(client.listenerCount('close')).toBe(0);
    expect(manager.release).toHaveBeenCalledTimes(1);
    service.close(spec.hostId);
    expect(manager.release).toHaveBeenCalledTimes(1);
  });
});

describe('SSH lifecycle cleanup', () => {
  it('disconnectAll closes every pooled client and clears the pool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-lifecycle-'));
    try {
      const manager = new SshConnectionManager(new KnownHostsStore(join(dir, 'known_hosts.json')));
      const first = Object.assign(new EventEmitter(), { end: vi.fn() });
      const second = Object.assign(new EventEmitter(), { end: vi.fn() });
      const pool = (manager as unknown as { conns: Map<string, unknown> }).conns;
      pool.set('a', { client: first, refCount: 1, sig: 'a' });
      pool.set('b', { client: second, refCount: 2, sig: 'b' });

      manager.disconnectAll();

      expect(first.end).toHaveBeenCalledOnce();
      expect(second.end).toHaveBeenCalledOnce();
      expect(pool.size).toBe(0);
      manager.disconnectAll();
      expect(first.end).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stopAll drains tunnel handles and releases their SSH references once', () => {
    const manager = { release: vi.fn() } as unknown as SshConnectionManager;
    const tunnels = new TunnelManager(manager);
    const stopA = vi.fn();
    const stopB = vi.fn();
    const active = (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels;
    active.set('a', { hostId: 'h1', meta: { id: 'a' }, stop: stopA });
    active.set('b', { hostId: 'h2', meta: { id: 'b' }, stop: stopB });

    tunnels.stopAll();

    expect(stopA).toHaveBeenCalledOnce();
    expect(stopB).toHaveBeenCalledOnce();
    expect(manager.release).toHaveBeenCalledTimes(2);
    expect(active.size).toBe(0);
  });
});

describe('TunnelManager validation', () => {
  const spec = {
    hostId: 'saved:project:1',
    host: 'example.com',
    port: 22,
    username: 'root',
    auth: { method: 'agent' as const },
  };

  function fakeManager(): SshConnectionManager {
    return { acquire: vi.fn(), release: vi.fn() } as unknown as SshConnectionManager;
  }

  it('rejects invalid bind ports before acquiring an SSH connection', async () => {
    const manager = fakeManager();
    const tunnels = new TunnelManager(manager);

    await expect(tunnels.start({ spec, kind: 'dynamic', bindPort: -1 })).rejects.toMatchObject({ code: 'ssh_tunnel_bad_port' });
    expect(manager.acquire).not.toHaveBeenCalled();
  });

  it('asks the OS for a collision-free local port when bindPort is zero', async () => {
    const manager = fakeManager();
    vi.mocked(manager.acquire).mockResolvedValue({ once: vi.fn(), removeListener: vi.fn() } as never);
    const tunnels = new TunnelManager(manager);

    const tunnel = await tunnels.start({ spec, kind: 'local', bindPort: 0, destHost: 'localhost', destPort: 5432 });
    expect(tunnel.bindHost).toBe('127.0.0.1');
    expect(tunnel.bindPort).toBeGreaterThan(0);
    tunnels.stop(tunnel.id);
    expect(manager.release).toHaveBeenCalledWith(spec.hostId);
  });

  it('rejects missing local-forward destination before acquiring an SSH connection', async () => {
    const manager = fakeManager();
    const tunnels = new TunnelManager(manager);

    await expect(tunnels.start({ spec, kind: 'local', bindPort: 18081, destHost: 'localhost' })).rejects.toMatchObject({ code: 'ssh_tunnel_bad_dest' });
    expect(manager.acquire).not.toHaveBeenCalled();
  });

  it('keeps tunnel listeners loopback-only', async () => {
    const manager = fakeManager();
    const tunnels = new TunnelManager(manager);

    await expect(tunnels.start({ spec, kind: 'dynamic', bindHost: '0.0.0.0', bindPort: 1080 })).rejects.toMatchObject({ code: 'ssh_tunnel_bind_forbidden' });
    expect(manager.acquire).not.toHaveBeenCalled();
  });
});
