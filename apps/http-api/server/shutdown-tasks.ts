/**
 * Process-wide shutdown task registry.
 *
 * Long-lived resources created deep inside `createAppDeps` (ONNX sessions,
 * future per-deps disposables) register a task here at construction time;
 * the entrypoints (http-api gracefulShutdown, Electron will-quit) run them
 * all without having to know what exists. Tasks never abort shutdown:
 * failures are logged and swallowed.
 */

type ShutdownTask = { name: string; fn: () => Promise<void> | void };

const tasks: ShutdownTask[] = [];
let ran = false;

export function registerShutdownTask(name: string, fn: () => Promise<void> | void): void {
  tasks.push({ name, fn });
}

/** Run all registered tasks (allSettled). Idempotent — second call is a no-op. */
export async function runShutdownTasks(): Promise<void> {
  if (ran) return;
  ran = true;
  const results = await Promise.allSettled(tasks.map((t) => Promise.resolve(t.fn())));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[shutdown] task ${tasks[i].name} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
}
