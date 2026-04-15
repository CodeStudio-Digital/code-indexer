/**
 * Runtime Hook Registry — lifecycle event hooks for the coder runner.
 *
 * Hooks fire during execution at well-defined points:
 * - Before/after tool calls
 * - On provider errors
 * - On fallback activation
 * - On session completion
 *
 * All hooks run in try/catch with a 5s timeout — a misbehaving hook
 * never crashes the runner. Hooks are registered programmatically
 * (not file-based like the project hooks in hooks.ts).
 */
import type { ToolResult } from './tool.js';
import type { ChatUsage } from './messages.js';

export type HookPhase = 'before' | 'after';

// ─── Context types ────────────────────────────────────────────────

export interface BaseHookContext {
  sessionId: number;
  projectName: string;
  provider: string;
  model: string;
  turn: number;
}

export interface ToolCallHookContext extends BaseHookContext {
  toolName: string;
  toolArgs: Record<string, unknown>;
  phase: HookPhase;
  /** Only available in 'after' phase. */
  result?: ToolResult;
  /** Only available in 'after' phase. */
  durationMs?: number;
}

export interface ErrorHookContext extends BaseHookContext {
  error: Error;
  errorType: 'provider' | 'tool' | 'doom_loop' | 'timeout';
  willRetry: boolean;
  willFallback: boolean;
}

export interface FallbackHookContext extends BaseHookContext {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  triggerError: string;
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
  private toolCallBefore: HookHandler<ToolCallHookContext>[] = [];
  private toolCallAfter: HookHandler<ToolCallHookContext>[] = [];
  private errorHandlers: HookHandler<ErrorHookContext>[] = [];
  private fallbackHandlers: HookHandler<FallbackHookContext>[] = [];
  private completionHandlers: HookHandler<CompletionHookContext>[] = [];

  onToolCall(phase: HookPhase, handler: HookHandler<ToolCallHookContext>): void {
    if (phase === 'before') this.toolCallBefore.push(handler);
    else this.toolCallAfter.push(handler);
  }

  onError(handler: HookHandler<ErrorHookContext>): void {
    this.errorHandlers.push(handler);
  }

  onFallback(handler: HookHandler<FallbackHookContext>): void {
    this.fallbackHandlers.push(handler);
  }

  onCompletion(handler: HookHandler<CompletionHookContext>): void {
    this.completionHandlers.push(handler);
  }

  async fireToolCall(ctx: ToolCallHookContext): Promise<void> {
    const handlers = ctx.phase === 'before' ? this.toolCallBefore : this.toolCallAfter;
    for (const h of handlers) {
      await safeRun(h, ctx, `toolCall:${ctx.phase}:${ctx.toolName}`);
    }
  }

  async fireError(ctx: ErrorHookContext): Promise<void> {
    for (const h of this.errorHandlers) {
      await safeRun(h, ctx, `error:${ctx.errorType}`);
    }
  }

  async fireFallback(ctx: FallbackHookContext): Promise<void> {
    for (const h of this.fallbackHandlers) {
      await safeRun(h, ctx, `fallback:${ctx.from.provider}->${ctx.to.provider}`);
    }
  }

  async fireCompletion(ctx: CompletionHookContext): Promise<void> {
    for (const h of this.completionHandlers) {
      await safeRun(h, ctx, `completion:${ctx.reason}`);
    }
  }

  /** Returns true if any handlers are registered. */
  get hasHandlers(): boolean {
    return (
      this.toolCallBefore.length > 0 ||
      this.toolCallAfter.length > 0 ||
      this.errorHandlers.length > 0 ||
      this.fallbackHandlers.length > 0 ||
      this.completionHandlers.length > 0
    );
  }
}
