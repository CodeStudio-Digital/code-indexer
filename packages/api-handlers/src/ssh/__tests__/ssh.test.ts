import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientChannel } from 'ssh2';
import { KnownHostsStore } from '../known-hosts.js';
import { adaptChannelToIPty } from '../ssh-pty-adapter.js';

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
