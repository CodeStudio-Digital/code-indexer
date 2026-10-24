export interface NativeDuplexOptions {
  executable: string; arguments: string[]; cwd: string; environment: Record<string, string>; timeoutMs: number;
  /** Stream stderr separately through readOutput; false preserves MCP framing. */
  streamStderr?: boolean;
  tty?: boolean;
  columns?: number;
  rows?: number;
}
export interface NativeDuplexResult {
  processId: number; exitCode: number; cancelled: boolean; timedOut: boolean; reaped: boolean;
  stderrHead: Uint8Array; stderrTail: Uint8Array; stderrTotalBytes: number;
}
export interface NativeStdinWrite { wait(): Promise<void> }
export interface NativeHostDuplexProcess {
  readonly processId: number;
  /** Consumes and clears the provided buffer; queue admission is synchronous. */
  write(bytes: Uint8Array): NativeStdinWrite;
  read(): Promise<Uint8Array | null>;
  readOutput?(): Promise<{ bytes: Uint8Array; stderr: boolean } | null>;
  cancel(): void;
  wait(): Promise<NativeDuplexResult>;
}
