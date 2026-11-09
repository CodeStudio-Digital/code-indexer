import type { ToolResult } from '../core/tool.js';
import type { AgentRuntimeEnv } from './shell-port.js';

export interface PersistentCommandRequest {
  onProcessExit?: (completion: Promise<void>) => void;
  signal?: AbortSignal;
  yieldMs: number;
  /** Called synchronously immediately before spawn or stdin queue admission. */
  assertFence(): void;
}
/** Attempt-owned sessions; implementations must prove physical cleanup on close. */
export interface IPersistentCommandPort {
  readonly supportsWorkspaceExitReceipts?: boolean;
  readonly commandSpecSupported?: boolean;
  readonly mutationFenceAttested: true;
  start(input: PersistentCommandRequest & {
    commandSpec?: import('../tools/command-spec.js').CommandSpec;
    command: string; cwd: string; tty: boolean; maxOutputBytes: number; runtimeEnv?: AgentRuntimeEnv;
    columns?: number; rows?: number;
  }): Promise<ToolResult>;
  write(input: PersistentCommandRequest & { sessionId: string; chars: string }): Promise<ToolResult>;
  list(): ToolResult;
  stop?(input: PersistentCommandRequest & { sessionId: string }): Promise<ToolResult>;
  readOutput?(input: { outputRef: string; cursor?: string; limit?: number }): Promise<ToolResult>;
  close(): Promise<void>;
}
