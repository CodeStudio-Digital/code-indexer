import { Script } from 'node:vm';

// Only this fixed program runs in the VM; the pattern and text are data.
// One deadline covers the complete scan, including pathological backtracking.
const scan = new Script('const re = new RegExp(pattern, flags); mode === "first" ? texts.findIndex(s => re.test(s)) : texts.flatMap((s, i) => re.test(s) ? [i] : [])');
const trustedOperation = new Script('operation()');
/** Deadline for our synchronous text algorithms; never executes caller code. */
export function boundedTextOperation<T>(operation: () => T, signal?: AbortSignal): T {
  signal?.throwIfAborted();
  const result = trustedOperation.runInNewContext({ operation }, { timeout: 100,
    contextCodeGeneration: { strings: false, wasm: false } }) as T;
  signal?.throwIfAborted();
  return result;
}
export function scanPattern(pattern: string, texts: string[], mode: 'first', signal?: AbortSignal): number;
export function scanPattern(pattern: string, texts: string[], mode: 'filter', signal?: AbortSignal): number[];
export function scanPattern(pattern: string, texts: string[], mode: 'first' | 'filter', signal?: AbortSignal): number | number[] {
  signal?.throwIfAborted();
  if (pattern.length > 1024) throw new Error('Pattern must be at most 1024 characters');
  try {
    const result = scan.runInNewContext({ pattern, texts, flags: mode === 'first' ? 'i' : '', mode },
      { timeout: 50, contextCodeGeneration: { strings: false, wasm: false } }) as number | number[];
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error('Pattern scan exceeded 50 ms; use a simpler expression or a narrower file');
    }
    throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}
