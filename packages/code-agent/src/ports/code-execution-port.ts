/** An evaluator owns only JavaScript. Every capability still executes through
 * the invoking tool's policy/receipt proxy in the Host. */
export interface CodeExecutionInput {
  code: string;
  timeoutMs: number;
  wallTimeoutMs: number;
  maxOutputBytes: number;
  priorityErrorBytes: number;
  signal?: AbortSignal;
  sandbox: Record<string, unknown>;
  toolNames: string[];
  allToolNames: string[];
  onOmittedLogs(lines: number, bytes: number, errorTail: string[]): void;
}

export interface CodeExecutionSession {
  readonly result: Promise<unknown>;
  /** Must wait for physical termination, not just a cancellation request. */
  close(): Promise<void>;
}

export interface CodeExecutionPort {
  start(input: CodeExecutionInput): CodeExecutionSession;
}
