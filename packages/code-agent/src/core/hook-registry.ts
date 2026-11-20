/**
 * Runtime Hook Registry — lifecycle event hooks for the coder runner.
 *
 * The runner fires one hook point: session completion (main runners only).
 *
 * All hooks run in try/catch with a 5s timeout — a misbehaving hook
 * never crashes the runner. Hooks are registered programmatically
 * (not file-based like the project hooks in hooks.ts).
 */
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { SessionId } from '@mcp/session-storage';

// ─── Context types ────────────────────────────────────────────────

export interface BaseHookContext {
  sessionId: SessionId;
  projectName: string;
  provider: string;
  model: string;
  turn: number;
}

export interface CompletionHookContext extends BaseHookContext {
  reason: string;
  totalUsage: ChatUsage;
  turnCount: number;
}

// ─── Handler types ────────────────────────────────────────────────

export type HookHandler<T> = (ctx: T) => void | Promise<void>;

// ─── Registry ───────────────────────────────────────────────���─────

const HOOK_TIMEOUT_MS = 5000;

async function safeRun<T>(handler: HookHandler<T>, ctx: T, label: string): Promise<void> {
  try {
    const result = handler(ctx);
    if (result && typeof (result as Promise<void>).then === 'function') {
      await Promise.race([
        result,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`Hook ${label} timed out after ${HOOK_TIMEOUT_MS}ms`)), HOOK_TIMEOUT_MS),
        ),
      ]);
    }
  } catch (e) {
    console.warn(`[coder-hooks] ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export class RuntimeHookRegistry {
  private completionHandlers: HookHandler<CompletionHookContext>[] = [];

  onCompletion(handler: HookHandler<CompletionHookContext>): void {
    this.completionHandlers.push(handler);
  }

  async fireCompletion(ctx: CompletionHookContext): Promise<void> {
    for (const h of this.completionHandlers) {
      await safeRun(h, ctx, `completion:${ctx.reason}`);
    }
  }

  /** Returns true if any handlers are registered. */
  get hasHandlers(): boolean {
    return this.completionHandlers.length > 0;
  }
}
