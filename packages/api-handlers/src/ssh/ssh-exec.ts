/**
 * One-shot SSH `exec` that WAITS for completion and returns captured
 * stdout/stderr + exit code — a non-PTY sibling of the shell/snippet path in
 * `index.ts`. Used for scripted remote operations (zip/tar/unzip) where the
 * caller needs the RESULT, not a live terminal stream.
 *
 * Output is capped (default 1 MB per stream → `truncated`) and the command is
 * killed after a timeout so a hung or runaway command can't wedge the pooled
 * connection. Acquire happens before the try so a failed dial holds no ref;
 * the `finally` releases the one ref a successful acquire took.
 */

import { ApiError, type SshConnectSpec, type SshExecResult } from '@mcp/api-bus';
import type { SshConnectionManager } from './ssh-connection-manager.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export async function sshExec(
  manager: SshConnectionManager,
  spec: SshConnectSpec,
  command: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SshExecResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = await manager.acquire(spec); // throws host-key/connect errors — no ref held on failure
  try {
    return await new Promise<SshExecResult>((resolve, reject) => {
      client.exec(command, {}, (err, channel) => {
        if (err) {
          reject(new ApiError('ssh_exec_failed', 502, err.message));
          return;
        }
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let code: number | null = null;
        const cap = (cur: string, chunk: string): string => {
          if (cur.length >= maxBytes) {
            truncated = true;
            return cur;
          }
          if (cur.length + chunk.length > maxBytes) {
            truncated = true;
            return cur + chunk.slice(0, maxBytes - cur.length);
          }
          return cur + chunk;
        };
        const timer = setTimeout(() => {
          try {
            channel.close();
          } catch {
            /* already closed */
          }
          reject(new ApiError('ssh_exec_timeout', 504, `command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        channel.on('data', (d: Buffer) => {
          stdout = cap(stdout, d.toString('utf8'));
        });
        channel.stderr.on('data', (d: Buffer) => {
          stderr = cap(stderr, d.toString('utf8'));
        });
        channel.on('exit', (c: number | null) => {
          code = c;
        });
        channel.once('close', () => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, truncated });
        });
        channel.once('error', (e: Error) => {
          clearTimeout(timer);
          reject(new ApiError('ssh_exec_failed', 502, e.message));
        });
      });
    });
  } finally {
    manager.release(spec.hostId, client);
  }
}
