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
let shutdownPromise: Promise<void> | null = null;
let completed = false;

export function registerShutdownTask(name: string, fn: () => Promise<void> | void): void {
  if (completed) {
    // A resource created during a late shutdown race must not escape merely
    // because the first drain already completed.
    void Promise.resolve()
      .then(fn)
      .catch((reason) => {
        console.warn(`[shutdown] late task ${name} failed: ${reason instanceof Error ? reason.message : String(reason)}`);
      });
    return;
  }
  tasks.push({ name, fn });
}

/** Run all registered tasks (allSettled). Idempotent — second call is a no-op. */
export async function runShutdownTasks(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    // Drain in waves so tasks registered by another disposer are included.
    while (tasks.length > 0) {
      const wave = tasks.splice(0);
      const results = await Promise.allSettled(wave.map((t) => Promise.resolve().then(t.fn)));
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.warn(`[shutdown] task ${wave[i].name} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        }
      });
    }
    completed = true;
  })();
  return shutdownPromise;
}
