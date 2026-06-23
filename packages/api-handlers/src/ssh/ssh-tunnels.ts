/**
 * Port-forwarding manager for the embedded SSH client.
 *
 *   - local:   a local `net` listener; each connection is `forwardOut`-ed
 *              through the remote to `dest`.
 *   - remote:  `forwardIn` on the remote; each inbound connection is piped to
 *              a local `net.connect(dest)`.
 *   - dynamic: a local SOCKS5 proxy; each CONNECT egresses via `forwardOut`.
 *
 * Each tunnel rides the host's POOLED ssh2 connection (ref-counted via the
 * shared connection manager), so a forward and a shell can share one TCP
 * connection. Byte counters are best-effort, for the UI.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';
import { ApiError, type SshTunnel, type SshTunnelInput } from '@mcp/api-bus';
import type { SshConnectionManager } from './ssh-connection-manager.js';

interface ActiveTunnel {
  meta: SshTunnel;
  hostId: string;
  stop: () => void;
}

export class TunnelManager {
  private readonly tunnels = new Map<string, ActiveTunnel>();
  /**
   * Per-Client remote-forward routing table: destPort → owning handler. ssh2
   * fans every `tcp connection` event to ALL listeners, so registering one
   * listener per remote tunnel made siblings cross-deny each other's channels.
   * Instead we register ONE dispatcher per Client and route by destPort.
   */
  private readonly remoteForwards = new WeakMap<Client, Map<number, (info: { destPort: number }, accept: () => ClientChannel) => void>>();

  constructor(private readonly manager: SshConnectionManager) {}

  async start(input: SshTunnelInput): Promise<SshTunnel> {
    const bindHost = input.bindHost ?? '127.0.0.1';
    // Default to loopback-only (OpenSSH GatewayPorts semantics). A non-loopback
    // bind turns a local proxy/forward into a network-reachable pivot, so refuse
    // it unless a future explicit opt-in is added.
    if (!isLoopback(bindHost)) {
      throw new ApiError('ssh_tunnel_bind_forbidden', 400, `non-loopback bind '${bindHost}' is not allowed`);
    }
    const client = await this.manager.acquire(input.spec); // throws host-key / connect errors
    const meta: SshTunnel = {
      id: randomUUID(),
      hostId: input.spec.hostId,
      kind: input.kind,
      bindHost,
      bindPort: input.bindPort,
      destHost: input.destHost,
      destPort: input.destPort,
      bytesUp: 0,
      bytesDown: 0,
    };
    try {
      const active =
        input.kind === 'local'
          ? await this.startLocal(client, input, meta)
          : input.kind === 'remote'
            ? await this.startRemote(client, input, meta)
            : await this.startDynamic(client, input, meta);
      this.tunnels.set(meta.id, active);
      return meta;
    } catch (err) {
      this.manager.release(input.spec.hostId);
      throw err;
    }
  }

  stop(tunnelId: string): void {
    const t = this.tunnels.get(tunnelId);
    if (!t) return;
    this.tunnels.delete(tunnelId);
    try {
      t.stop();
    } finally {
      this.manager.release(t.hostId);
    }
  }

  list(): SshTunnel[] {
    return [...this.tunnels.values()].map((t) => t.meta);
  }

  /** Bind a net listener, resolving only after it is actually listening; reject on bind failure. */
  private listen(server: net.Server, meta: SshTunnel, hostId: string): Promise<ActiveTunnel> {
    return new Promise<ActiveTunnel>((resolve, reject) => {
      server.once('error', (err) => reject(new ApiError('ssh_tunnel_failed', 502, `listen ${meta.bindHost}:${meta.bindPort} failed: ${err.message}`)));
      server.listen(meta.bindPort, meta.bindHost, () => {
        server.removeAllListeners('error');
        server.on('error', () => undefined); // post-bind runtime socket errors are non-fatal
        resolve({ meta, hostId, stop: () => server.close() });
      });
    });
  }

  private startLocal(client: Client, input: SshTunnelInput, meta: SshTunnel): Promise<ActiveTunnel> {
    if (!input.destHost || input.destPort == null) {
      return Promise.reject(new ApiError('ssh_tunnel_bad_dest', 400, 'local forward needs destHost + destPort'));
    }
    const server = net.createServer((socket) => {
      client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        input.destHost!,
        input.destPort!,
        (err, stream) => {
          if (err) {
            socket.destroy();
            return;
          }
          pipeCounting(socket, stream, meta);
        },
      );
    });
    return this.listen(server, meta, input.spec.hostId);
  }

  /** Register a remote-forward handler on the per-Client dispatcher; returns an unregister fn. */
  private registerRemoteForward(
    client: Client,
    port: number,
    handler: (info: { destPort: number }, accept: () => ClientChannel) => void,
  ): () => void {
    let map = this.remoteForwards.get(client);
    if (!map) {
      map = new Map();
      this.remoteForwards.set(client, map);
      const table = map;
      client.on('tcp connection', (info: { destPort: number }, accept: () => ClientChannel, deny: () => void) => {
        const h = table.get(info.destPort);
        if (h) h(info, accept);
        else deny(); // no tunnel claims this port → deny exactly once
      });
    }
    map.set(port, handler);
    return () => {
      this.remoteForwards.get(client)?.delete(port);
    };
  }

  private startRemote(client: Client, input: SshTunnelInput, meta: SshTunnel): Promise<ActiveTunnel> {
    if (!input.destHost || input.destPort == null) {
      return Promise.reject(new ApiError('ssh_tunnel_bad_dest', 400, 'remote forward needs destHost + destPort'));
    }
    return new Promise<ActiveTunnel>((resolve, reject) => {
      client.forwardIn(meta.bindHost, meta.bindPort, (err) => {
        if (err) {
          reject(new ApiError('ssh_tunnel_failed', 502, `remote forward bind failed: ${err.message}`));
          return;
        }
        const unregister = this.registerRemoteForward(client, meta.bindPort, (_info, accept) => {
          const stream = accept();
          const socket = net.connect(input.destPort!, input.destHost!, () => pipeCounting(socket, stream, meta));
          socket.on('error', () => stream.close());
        });
        resolve({
          meta,
          hostId: input.spec.hostId,
          stop: () => {
            unregister();
            try {
              client.unforwardIn(meta.bindHost, meta.bindPort);
            } catch {
              /* connection may already be gone */
            }
          },
        });
      });
    });
  }

  private startDynamic(client: Client, input: SshTunnelInput, meta: SshTunnel): Promise<ActiveTunnel> {
    const server = net.createServer((socket) => handleSocks5(socket, client, meta));
    return this.listen(server, meta, input.spec.hostId);
  }
}

/** Loopback bind addresses (the only ones allowed without an explicit gateway opt-in). */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
}

/** Bidirectional pipe that tallies bytes into the tunnel meta. */
function pipeCounting(local: net.Socket, remote: ClientChannel, meta: SshTunnel): void {
  local.on('data', (d: Buffer) => {
    meta.bytesUp += d.length;
  });
  remote.on('data', (d: Buffer) => {
    meta.bytesDown += d.length;
  });
  local.pipe(remote);
  remote.pipe(local);
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    local.destroy();
    remote.close();
  };
  local.on('error', cleanup);
  remote.on('error', cleanup);
  // Symmetric half-close: a clean FIN on either side must close the OTHER, else
  // a half-open channel leaks on the pooled SSH connection until the peer reacts.
  remote.on('close', cleanup);
  local.on('close', cleanup);
}

// ─── Minimal SOCKS5 (CONNECT only, no auth) for dynamic forwarding ────────

function handleSocks5(socket: net.Socket, client: Client, meta: SshTunnel): void {
  let stage: 'greeting' | 'request' | 'piping' = 'greeting';
  let buf = Buffer.alloc(0);

  const fail = (): void => {
    socket.destroy();
  };

  // Bound a half-open handshake: a peer that stalls before reaching the piping
  // stage is destroyed, so partial-handshake sockets can't accumulate.
  socket.setTimeout(10_000);
  socket.on('timeout', () => {
    if (stage !== 'piping') socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    if (stage === 'piping') return;
    buf = Buffer.concat([buf, chunk]);

    if (stage === 'greeting') {
      if (buf.length < 2) return;
      if (buf[0] !== 0x05) return fail(); // reject a bad version WITHOUT buffering up to 255 nmethods
      const nmethods = buf[1];
      if (buf.length < 2 + nmethods) return;
      socket.write(Buffer.from([0x05, 0x00])); // version 5, no-auth
      buf = buf.subarray(2 + nmethods);
      stage = 'request';
    }

    if (stage === 'request') {
      if (buf.length < 4) return;
      const [ver, cmd, , atyp] = buf;
      if (ver !== 0x05 || cmd !== 0x01) {
        // only CONNECT supported → reply "command not supported"
        socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return fail();
      }
      let host: string;
      let offset: number;
      if (atyp === 0x01) {
        if (buf.length < 10) return;
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        offset = 8;
      } else if (atyp === 0x03) {
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString('utf8');
        offset = 5 + len;
      } else if (atyp === 0x04) {
        if (buf.length < 22) return;
        const parts: string[] = [];
        for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
        host = parts.join(':');
        offset = 20;
      } else {
        socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // addr type not supported
        return fail();
      }
      const port = buf.readUInt16BE(offset);
      const rest = buf.subarray(offset + 2); // bytes the client pipelined right after CONNECT
      stage = 'piping';
      socket.pause(); // hold delivery until the remote pipe is wired (don't drop bytes in the async window)
      socket.setTimeout(0); // handshake done; pipeCounting owns idleness now
      client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port, (err, stream) => {
        if (err) {
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // connection refused
          socket.destroy();
          return;
        }
        // success reply (bound addr 0.0.0.0:0 — clients ignore it)
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (rest.length > 0) stream.write(rest); // flush pipelined bytes BEFORE wiring pipes (preserve order)
        pipeCounting(socket, stream, meta);
        socket.resume();
      });
    }
  });

  socket.on('error', fail);
}
