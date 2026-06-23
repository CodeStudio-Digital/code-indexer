/**
 * Global "files touched" sink (TODO-I2 wiring — Sprint 1 closeout).
 *
 * Mirrors the pattern in `tool-selection/global-filter.ts`: a process-
 * wide hook the host sets once at boot, and that fs tools call after a
 * successful read/edit/write. Keeps the @mcp/code-agent package free
 * of any @mcp/indexer import — the host wires the actual
 * `RecentFilesSource.touch(...)` call.
 *
 * **Why a callback and not a direct RecentFilesSource reference**:
 *   - Avoids cross-package dependency (code-agent → indexer)
 *   - Tools don't need to know about projectId, fileId — they only
 *     emit "I just touched <path>"; the host resolves the IDs
 *   - When the host doesn't wire a sink (CLI/tests), tools become
 *     no-ops — bit-identical to pre-I2 behavior
 *
 * Concurrency: this is a single getter/setter pair. Last write wins.
 * No-op when unset.
 */

/**
 * Side-effect signature called by fs tools after a successful op.
 * Implementations MUST swallow their own errors — the tools wrap the
 * call in try/catch anyway, but defensive sinks are friendlier.
 */
export type RecentFilesTouchSink = (
  event: {
    /** Absolute filesystem path. The host resolves it back to a project/fileId. */
    absolutePath: string;
    /** 'edit' for write/edit/create; 'view' for read. Edit wins on tie in the source. */
    kind: 'view' | 'edit';
  },
) => void;

let globalSink: RecentFilesTouchSink | null = null;

/**
 * Wire the sink at host boot. `apps/http-api/server/deps.ts` calls this
 * once with a closure that resolves projectId via the active workspace
 * and calls `recentFilesSource.touch(...)`. Unset → tools no-op.
 *
 * Passing `null` clears the wiring (used by tests).
 */
export function setGlobalRecentFilesTouchSink(sink: RecentFilesTouchSink | null): void {
  globalSink = sink;
}

/**
 * Internal — fs tools call this after their primary op. Returns the
 * sink or null. The double-getter shape keeps the call site one-liner
 * tolerant of the unset case.
 */
export function emitRecentFileTouched(event: { absolutePath: string; kind: 'view' | 'edit' }): void {
  const sink = globalSink;
  if (!sink) return;
  try {
    sink(event);
  } catch (e) {
    console.warn(
      `[code-agent] recent-files touch sink threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Test helper — reset state between tests. */
export function clearGlobalRecentFilesTouchSinkForTests(): void {
  globalSink = null;
}
