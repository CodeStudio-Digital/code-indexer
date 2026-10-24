/**
 * Central registry of OS-level children the desktop app spawns at runtime
 * (terminal PTYs, the shared runner PTY manager, the dev-http listener, …).
 *
 * Why this exists: Electron's `will-quit` already disposes the worker pools,
 * indexer, LSP servers and DB pools. But node-pty terminals and the dev
 * servers they launch (`npm run dev` → vite/esbuild, `winpty-agent.exe`)
 * were only killed when the renderer's MessagePort closed — on a hard quit
 * they orphaned. This registry is the single place every such spawn site
 * registers with, and `killAll()` guarantees they all die on the way out.
 *
 * Main-process only — it owns `taskkill` / `process.kill` (see tree-kill.ts).
 *
 * Contract of `TrackedChild.kill(force)`:
 *   - force=false → graceful native teardown (`pty.kill()`, `server.close()`).
 *   - force=true  → escalate now (used from the synchronous crash path).
 * Both paths additionally tree-kill entries carrying a `pid`: normal cleanup
 * awaits the asynchronous helper queue; the exit-only path uses one bounded
 * synchronous batch.
 */

import { killProcessTreesSync } from '@mcp/shared/utils/process-tree.js';
import { killTree } from './tree-kill.js';

type ChildKind = 'pty' | 'process' | 'server';

interface TrackedChild {
  /** Stable id; auto-assigned by `register` when omitted. */
  id: string;
  kind: ChildKind;
  /** OS pid for tree-kill. Omit for in-process handles (servers, pools). */
  pid?: number;
  /** Human label for diagnostics: 'terminal:host', 'runner-ptys', 'dev-http'. */
  label: string;
  /** Graceful (force=false) then hard (force=true) teardown. Must not throw. */
  kill: (force: boolean) => void | Promise<void>;
}

function withTimeout(p: Promise<unknown>, ms: number): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void Promise.resolve(p)
      .catch(() => undefined)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
  });
}

class ChildProcessRegistry {
  private readonly children = new Map<string, TrackedChild>();
  private seq = 0;

  /** Register a child; returns an unregister fn for the normal-exit path. */
  register(child: Omit<TrackedChild, 'id'> & { id?: string }): () => void {
    const id = child.id ?? `child-${(this.seq += 1)}`;
    this.children.set(id, { ...child, id });
    return () => this.unregister(id);
  }

  unregister(id: string): void {
    this.children.delete(id);
  }

  list(): TrackedChild[] {
    return [...this.children.values()];
  }

  /**
   * Async teardown for the normal quit path: graceful kill of every child
   * (bounded by `graceMs` so one hung handle can't block quit), then a
   * force tree-kill of any pid that may still have survivors. Idempotent.
   */
  async killAll({ graceMs }: { graceMs: number }): Promise<void> {
    const snapshot = this.list();
    this.children.clear();
    await Promise.allSettled(
      // Async IIFE so a SYNCHRONOUS throw from kill() becomes a rejected
      // promise (swallowed by withTimeout) instead of escaping the map.
      snapshot.map((c) => withTimeout((async () => c.kill(false))(), graceMs)),
    );
    await Promise.all(snapshot.map((c) => killTree(c.pid)));
  }

  /**
   * Synchronous last-resort sweep for the crash / `process.on('exit')` /
   * signal paths, where no async work can run. Fires `kill(true)` (ignoring
   * any returned promise) then tree-kills each pid.
   */
  killAllSync(): void {
    const snapshot = this.list();
    this.children.clear();
    for (const c of snapshot) {
      try {
        void c.kill(true);
      } catch {
        /* best-effort */
      }
    }
    killProcessTreesSync(snapshot.map((c) => c.pid));
  }
}

/** Process-wide singleton — imported by every main-process spawn site. */
export const childRegistry = new ChildProcessRegistry();
