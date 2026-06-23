/**
 * Adapt an `ssh2` shell channel to the `IPty` interface so it can be
 * registered into the shared PTY manager. Once registered, an SSH shell is
 * indistinguishable from a local terminal: `terminal.output(id)` streams it,
 * `terminal.write/resize/kill` drive it. This is the seam that lets the
 * entire terminal UI work over SSH without any SSH-specific changes.
 *
 * stdout and stderr are merged into one stream (xterm renders both inline).
 * The remote shell has no local OS pid, so `pid` is a synthetic `-1`.
 */

import type { ClientChannel } from 'ssh2';
import type { IPty } from '../terminal/pty-manager.js';

export interface SshPtyAdapterOpts {
  cols: number;
  rows: number;
  /** Called once when the channel closes (or is killed) — used to release the pooled connection. */
  onClose?: () => void;
}

export function adaptChannelToIPty(channel: ClientChannel, opts: SshPtyAdapterOpts): IPty {
  let lastExitCode = 0;
  // ssh2 emits `exit` (with the remote exit code, or a signal name) before
  // `close`. Capture the code so the `close` that ends iteration carries it.
  channel.once('exit', (code: number | null) => {
    if (typeof code === 'number') lastExitCode = code;
  });

  const ipty: IPty = {
    pid: -1,
    cols: opts.cols,
    rows: opts.rows,

    onData(listener: (data: string) => void) {
      const onData = (d: Buffer | string): void => listener(typeof d === 'string' ? d : d.toString('utf8'));
      channel.on('data', onData);
      channel.stderr?.on('data', onData);
      return {
        dispose(): void {
          channel.removeListener('data', onData);
          channel.stderr?.removeListener('data', onData);
        },
      };
    },

    onExit(listener: (e: { exitCode: number; signal?: number }) => void) {
      const onClose = (): void => listener({ exitCode: lastExitCode });
      channel.once('close', onClose);
      return {
        dispose(): void {
          channel.removeListener('close', onClose);
        },
      };
    },

    write(data: string): void {
      channel.write(data);
    },

    resize(cols: number, rows: number): void {
      ipty.cols = cols;
      ipty.rows = rows;
      // ssh2 signature is (rows, cols, height_px, width_px).
      channel.setWindow(rows, cols, 0, 0);
    },

    kill(): void {
      try {
        channel.close();
      } catch {
        // already closed
      }
      opts.onClose?.();
    },
  };

  return ipty;
}
