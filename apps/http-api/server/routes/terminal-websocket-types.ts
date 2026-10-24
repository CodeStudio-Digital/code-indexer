import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { CompanySandboxStore } from '@mcp/store/company-sandbox-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { type CompanySessionId } from '@mcp/session-storage';

// ─── ws + node-pty surface (typed locally — no @types installed) ──
export interface WsLike {
  readyState: number;
  readonly OPEN: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: string | Buffer) => void): void;
  on(event: 'close' | 'error', listener: (err?: Error) => void): void;
  once(event: 'close', listener: () => void): void;
}

export interface WebSocketServerLike {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (ws: WsLike) => void,
  ): void;
}

export interface IPty {
  pid: number;
  cols: number;
  rows: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding?: string;
      /** Windows-only — force WinPTY when inside Electron (ConPTY's
       *  agent helper crashes on AttachConsole under GUI subsystem). */
      useConpty?: boolean;
    },
  ): IPty;
}

export interface TerminalUpgradeDeps {
  sessionStore: FsSessionStore;
  companySandboxStore: CompanySandboxStore;
  db: CodeIndexDB;
}

// ─── Spawn specifications ───────────────────────────────────────
export interface SpawnSpec {
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  label: string;
}

// ─── Per-connection plumbing ────────────────────────────────────
export interface TerminalCtx {
  sessionId: CompanySessionId;
  target: 'sandbox' | 'host';
  cols: number;
  rows: number;
}
