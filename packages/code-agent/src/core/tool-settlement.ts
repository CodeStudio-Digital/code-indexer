import type { ToolContext, ToolResult } from './tool.js';

/** Capture normalized arguments before the handler can modify them. Observers
 * receive only completion metadata, never the mutable tool result object. */
export function toolSettlementNotifier(context: ToolContext, toolName: string,
  input: Record<string, unknown>): (result: Pick<ToolResult, 'isError'>) => void {
  const observer = context.onToolSettled;
  if (!observer) return () => undefined;
  let toolArgs: Record<string, unknown>;
  try { toolArgs = structuredClone(input); } catch { return () => undefined; }
  const started = performance.now();
  return result => {
    const event = { toolName, toolArgs, result: { isError: result.isError === true },
      durationMs: performance.now() - started };
    // Return the result before auxiliary observers start; their completion
    // never changes the tool outcome. Durable result accounting is separate.
    setImmediate(() => { void Promise.resolve().then(() => observer(event)).catch(() => undefined); }).unref();
  };
}
