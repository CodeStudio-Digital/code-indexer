export interface NativeHostCommandOptions {
  executable: string; arguments: string[]; cwd: string; environment: Record<string, string>;
  stdin: Uint8Array; timeoutMs: number; maximumOutputBytes: number;
}
export interface NativeHostCommandResult {
  stdoutHead: Uint8Array; stdoutTail: Uint8Array; stdoutTotalBytes: number;
  stderrHead: Uint8Array; stderrTail: Uint8Array; stderrTotalBytes: number;
  processId: number; exitCode: number; cancelled: boolean; timedOut: boolean; reaped: boolean;
}
export interface NativeHostCommand {
  readonly processId: number;
  cancel(): void;
  wait(): Promise<NativeHostCommandResult>;
}
