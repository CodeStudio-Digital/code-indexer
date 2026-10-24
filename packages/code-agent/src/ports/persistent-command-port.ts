import type { ToolResult } from '../core/tool.js';
import type { AgentRuntimeEnv } from './shell-port.js';

export interface PersistentCommandRequest {
  signal?: AbortSignal;
  yieldMs: number;
  /** Called synchronously immediately before spawn or stdin queue admission. */
  assertFence(): void;
}
/** Attempt-owned sessions; implementations must prove physical cleanup on close. */
export interface IPersistentCommandPort {
  readonly mutationFenceAttested: true;
  start(input: PersistentCommandRequest & {
    command: string; cwd: string; tty: boolean; maxOutputBytes: number; runtimeEnv?: AgentRuntimeEnv;
    columns?: number; rows?: number;
  }): Promise<ToolResult>;
  write(input: PersistentCommandRequest & { sessionId: string; chars: string }): Promise<ToolResult>;
  list(): ToolResult;
  close(): Promise<void>;
}
