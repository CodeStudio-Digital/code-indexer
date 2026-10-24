import type { NativeRustHostAttemptRuntime } from '@mcp/agent-runtime-host';

export interface NativeHistoryWriter {
  readonly attemptId: string;
  readonly runtime: NativeRustHostAttemptRuntime;
}
const writers = new Map<string, NativeHistoryWriter>();

/** Process-local lookup only. Authority and all reads stay with the Rust writer. */
export function registerNativeHistoryWriter(sessionId: string, writer: NativeHistoryWriter): () => void {
  if (writers.has(sessionId) || writers.size >= 16) throw new Error('Native history writer is already registered or exceeds its bound');
  writers.set(sessionId, writer);
  return () => { if (writers.get(sessionId) === writer) writers.delete(sessionId); };
}
export function getNativeHistoryWriter(sessionId: string): NativeHistoryWriter | undefined { return writers.get(sessionId); }
