/**
 * Handlers for the `ssh` namespace — the embedded Termius-style SSH client.
 *
 * Runs in the Electron main process next to `sharedPtyManager`. `openShell`
 * dials (or reuses) a pooled `ssh2` connection, opens a shell channel,
 * adapts it to `IPty`, and registers it into the shared PTY manager — so the
 * renderer drives it through the EXISTING `terminal.*` API by `terminalId`.
 *
 * See `SshApi` (packages/api-bus/src/ssh.ts) for the host-key TOFU contract.
 */

import { join } from 'node:path';
import { ApiError, type SshApi, type SshHostKeyInfo } from '@mcp/api-bus';
import { ensureDataDir } from '@mcp/shared/utils/config.js';
import type { Client, ClientChannel } from 'ssh2';
import type { HandlerDeps } from '../types.js';
import { sharedPtyManager } from '../terminal/pty-manager.js';
import { SshConnectionManager } from './ssh-connection-manager.js';
import { KnownHostsStore } from './known-hosts.js';
import { adaptChannelToIPty } from './ssh-pty-adapter.js';
import { TunnelManager } from './ssh-tunnels.js';
import { SftpManager } from './ssh-sftp.js';
import { generateSshKey } from './ssh-keys.js';
import { readSshConfig } from './ssh-config-parser.js';
import { sshExec } from './ssh-exec.js';

let _manager: SshConnectionManager | null = null;
/** Process-wide pooled SSH connection manager (lazy so the data dir resolves at first use). */
export function sharedSshManager(): SshConnectionManager {
  if (!_manager) {
    _manager = new SshConnectionManager(new KnownHostsStore(join(ensureDataDir(), 'ssh', 'known_hosts.json')));
  }
  return _manager;
}

let _tunnels: TunnelManager | null = null;
function sharedTunnelManager(): TunnelManager {
  if (!_tunnels) _tunnels = new TunnelManager(sharedSshManager());
  return _tunnels;
}

let _sftp: SftpManager | null = null;
function sharedSftpManager(): SftpManager {
  if (!_sftp) _sftp = new SftpManager(sharedSshManager());
  return _sftp;
}

/** Drain every SSH-owned socket/channel/listener without creating lazy state. */
export function disposeSharedSshResources(): void {
  _sftp?.closeAll();
  _tunnels?.stopAll();
  _manager?.disconnectAll();
  _sftp = null;
  _tunnels = null;
  _manager = null;
}

export function createSshHandlers(_deps: HandlerDeps): SshApi {
  const manager = sharedSshManager();

  return {
    async openShell({ spec, cols = 80, rows = 24 }) {
      const client = await manager.acquire(spec); // throws ssh_host_key_* / ssh_connect_failed
      let channel: ClientChannel;
      try {
        channel = await openShellChannel(client, cols, rows);
      } catch (err) {
        manager.release(spec.hostId);
        throw err;
      }
      // Release the pooled connection exactly once, whether the channel is
      // killed from the UI or the remote closes it.
      let released = false;
      const releaseOnce = (): void => {
        if (released) return;
        released = true;
        manager.release(spec.hostId);
      };
      channel.once('close', releaseOnce);

      const ipty = adaptChannelToIPty(channel, { cols, rows, onClose: releaseOnce });
      const { id, entry } = sharedPtyManager.registerExternalPty(ipty);
      return { terminalId: id, pid: entry.pty.pid };
    },

    async runSnippet({ spec, command, cols = 80, rows = 24 }) {
      const client = await manager.acquire(spec);
      let channel: ClientChannel;
      try {
        channel = await openExecChannel(client, command, cols, rows);
      } catch (err) {
        manager.release(spec.hostId);
        throw err;
      }
      let released = false;
      const releaseOnce = (): void => {
        if (released) return;
        released = true;
        manager.release(spec.hostId);
      };
      channel.once('close', releaseOnce);
      const ipty = adaptChannelToIPty(channel, { cols, rows, onClose: releaseOnce });
      const { id, entry } = sharedPtyManager.registerExternalPty(ipty);
      return { terminalId: id, pid: entry.pty.pid };
    },

    async execCommand({ spec, command, timeoutMs, maxBytes }) {
      return sshExec(manager, spec, command, { timeoutMs, maxBytes });
    },

    async testConnection({ spec }) {
      try {
        await manager.acquire(spec);
        manager.release(spec.hostId); // we only needed to verify reachability/auth
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'ssh_host_key_unknown' || err.code === 'ssh_host_key_changed')) {
          return { ok: false, reason: err.message, hostKey: err.details?.hostKey as SshHostKeyInfo | undefined };
        }
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async trustHostKey(info) {
      manager.trust(info);
    },

    async disconnect({ hostId }) {
      manager.disconnect(hostId);
    },

    async tunnelStart(input) {
      return sharedTunnelManager().start(input);
    },

    async tunnelStop({ tunnelId }) {
      sharedTunnelManager().stop(tunnelId);
    },

    async tunnelList() {
      return sharedTunnelManager().list();
    },

    async sftpRealpath({ spec, path }) {
      return sharedSftpManager().realpath(spec, path);
    },
    async sftpList({ spec, path }) {
      return sharedSftpManager().list(spec, path);
    },
    async sftpMkdir({ spec, path }) {
      await sharedSftpManager().mkdir(spec, path);
    },
    async sftpRename({ spec, from, to }) {
      await sharedSftpManager().rename(spec, from, to);
    },
    async sftpRemove({ spec, path, isDir }) {
      await sharedSftpManager().remove(spec, path, isDir);
    },
    async sftpClose({ hostId }) {
      sharedSftpManager().close(hostId);
    },
    sftpDownloadStream({ spec, remotePath, localPath, transferId }) {
      return sharedSftpManager().download(spec, remotePath, localPath, transferId);
    },
    sftpUploadStream({ spec, localPath, remotePath, transferId }) {
      return sharedSftpManager().upload(spec, localPath, remotePath, transferId);
    },
    async sftpCancel({ transferId }) {
      sharedSftpManager().cancel(transferId);
    },
    async sftpReadFile({ spec, remotePath }) {
      return sharedSftpManager().readFile(spec, remotePath);
    },
    async generateKey(input) {
      return generateSshKey(input);
    },
    async importSshConfig() {
      return readSshConfig();
    },
    async sftpWriteFile({ spec, remotePath, content }) {
      return sharedSftpManager().writeFile(spec, remotePath, content);
    },
  };
}

/** Promisified `client.shell` with a sensible terminal type. */
function openShellChannel(client: Client, cols: number, rows: number): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.shell({ cols, rows, term: 'xterm-256color' }, (err, stream) => {
      if (err) reject(new ApiError('ssh_shell_failed', 502, err.message));
      else resolve(stream);
    });
  });
}

/** Promisified `client.exec` with a PTY so snippet output streams like a shell. */
function openExecChannel(client: Client, command: string, cols: number, rows: number): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.exec(command, { pty: { cols, rows, term: 'xterm-256color' } }, (err, stream) => {
      if (err) reject(new ApiError('ssh_exec_failed', 502, err.message));
      else resolve(stream);
    });
  });
}
