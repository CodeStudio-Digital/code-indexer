/**
 * Terminal WebSocket gateway — interactive PTY into the sandbox container
 * (via `podman exec -it`) OR into the host shell (PowerShell on Windows,
 * bash on macOS/Linux) for the session's project root.
 *
 * Phase D of the "living company" restructure. Wires xterm.js in the
 * dashboard to a live shell so the operator can run scripts in the
 * sandbox or against their local Node/Python/Unity setup without
 * leaving the agents UI.
 *
 * Protocol:
 *   - URL: `GET /ws/terminal/:sessionId?target=sandbox|host` (HTTP Upgrade)
 *   - Inbound frames (text, JSON):
 *       { type: 'data',   data: string }              user keystrokes
 *       { type: 'resize', cols: number, rows: number } resize the PTY
 *   - Outbound frames (text, JSON):
 *       { type: 'data', data: string }                PTY stdout/stderr
 *       { type: 'exit', code: number, signal?: number }  PTY exited
 *       { type: 'error', message: string }            unrecoverable error
 *
 * Security:
 *   - The HTTP server should bind to loopback in single-user dev. We
 *     additionally validate `Origin` against an allowlist (defaults to
 *     localhost + 127.0.0.1) and reject upgrades otherwise.
 *   - **Host target is gated by `MCP_HOST_TERMINAL_ENABLED=1`** — opt-in
 *     because it gives shell access to the operator's machine. A `host`
 *     upgrade without the flag returns 403.
 *   - Every host PTY open is logged with `{ sessionId, ts, pid }`.
 *
 * Native dependency: `node-pty`. Loaded lazily via `createRequire` so a
 * missing prebuild on exotic platforms degrades gracefully (returns a
 * 503 instead of failing module load and crashing the server).
 */
import { createRequire } from 'node:module';
import { type WebSocketServerLike, type NodePtyModule } from './terminal-websocket-types.js';

const require = createRequire(import.meta.url);

export const wsModule = require('ws') as {
  WebSocketServer: new (opts: { noServer: boolean }) => WebSocketServerLike;
};

let cachedPty: NodePtyModule | null | undefined;

export function tryLoadPty(): NodePtyModule | null {
  if (cachedPty !== undefined) return cachedPty;
  try {
    cachedPty = require('node-pty') as NodePtyModule;
  } catch (e) {
    console.warn(
      `[terminal-ws] node-pty failed to load — terminal feature disabled: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    cachedPty = null;
  }
  return cachedPty;
}
