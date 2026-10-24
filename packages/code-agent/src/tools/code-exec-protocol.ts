/** Bounded JSON protocol for the disposable evaluator. No credentials or
 * executable Host functions cross this pipe. node:vm is not a security sandbox. */
export const CODE_EXEC_FRAME_BYTES = 16 * 1024 * 1024;
export const CODE_EXEC_MAX_REQUESTS = 128;
export type CodeExecWireError = { name: string; message: string; [key: string]: unknown };
export function encodeCodeExecError(error: unknown): CodeExecWireError {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const out: CodeExecWireError = { name: typeof value.name === 'string' ? value.name : 'Error',
    message: typeof value.message === 'string' ? value.message : String(error) };
  for (const key of ['code', 'tool', 'detail', 'kind', 'retryable', 'suggestedAction', 'refusalKind', 'guardVerdict']) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}
export function decodeCodeExecError(error: CodeExecWireError): Error {
  return Object.assign(new Error(error.message), error);
}

export interface CodeExecBootstrap {
  code: string;
  timeoutMs: number;
  maxOutputBytes: number;
  priorityErrorBytes: number;
  tools: string[];
  schemas: Array<{ name: string; [key: string]: unknown }>;
  listing: unknown;
  changes: string[];
  stash: Array<[string, unknown]>;
}
