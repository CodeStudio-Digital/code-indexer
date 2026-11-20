/**
 * Injection policy — how much session-state to inject, and how often,
 * scaled by the session's effective context window (the same
 * `deriveTokenLimits(model, contextWindow).effective` the compaction gates use).
 *
 *   - standard (>64k): milestone injection (turn 1, post-compaction, or
 *     the block changed). Plenty of window; keep the tail lean.
 *   - short (≤64k): inject the state block EVERY turn (~275 tok). With a
 *     small window the summarizer is the only other continuity thread —
 *     this block is what keeps the model oriented after aggressive
 *     compaction. Tail-only, so the cached prefix is untouched.
 *   - minimal (≤16k): every turn, but skeletal.
 *
 * The short threshold is fixed at 64k tokens (no env var).
 */
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';
import type { SessionStateBudget } from './session-state.js';

export type InjectionMode = 'standard' | 'short' | 'minimal';

export interface InjectionPolicy {
  mode: InjectionMode;
  /** Session-state injection is a product invariant. */
  enabled: boolean;
  /** True → the block is injected every turn (short/minimal windows). */
  stateEveryTurn: boolean;
  budget: SessionStateBudget;
  /** Char budget for the project memory index (0 = off). */
  memoryIndexChars: number;
  /** Char budget for the session's conversation-chapter index. */
  chapterIndexChars: number;
  /** Char budget for the global user-preferences block (migration 145). Small
   *  + always-on (carried even on minimal windows) — prefs are cheap and
   *  always relevant. */
  userMemoryChars: number;
}

const MINIMAL_WINDOW_TOKENS = 16_000;
const DEFAULT_SHORT_WINDOW_TOKENS = 64_000;

function shortWindowThreshold(): number {
  return DEFAULT_SHORT_WINDOW_TOKENS;
}

export function resolveInjectionPolicy(
  model: string,
  opts: {
    /** True when `<active-context>` (Agent Loop v2) already carries
     *  todos every turn — the state block then omits them. */
    liveStateCovered?: boolean;
    /** Session-configured context window; null/undefined = the model's registered window. */
    contextWindow?: number | null;
  } = {},
): InjectionPolicy {
  const enabled = true;
  const effective = deriveTokenLimits(model, opts.contextWindow).effective;
  const includeLiveState = !opts.liveStateCovered;

  if (effective <= MINIMAL_WINDOW_TOKENS) {
    return {
      mode: 'minimal',
      enabled,
      stateEveryTurn: true,
      budget: {
        planChars: 120, noteSlots: 1, noteChars: 120,
        todoLines: 3, fileSlots: 0, includeLiveState,
      },
      memoryIndexChars: 0,
      chapterIndexChars: 400,
      userMemoryChars: 200,
    };
  }

  if (effective <= shortWindowThreshold()) {
    return {
      mode: 'short',
      enabled,
      stateEveryTurn: true,
      budget: {
        planChars: 280, noteSlots: 2, noteChars: 160,
        todoLines: 5, fileSlots: 3, includeLiveState,
      },
      memoryIndexChars: 400,
      chapterIndexChars: 800,
      userMemoryChars: 300,
    };
  }

  return {
    mode: 'standard',
    enabled,
    stateEveryTurn: false,
    budget: {
      planChars: 700, noteSlots: 4, noteChars: 280,
      todoLines: 8, fileSlots: 6, includeLiveState,
    },
    memoryIndexChars: 1200,
    chapterIndexChars: 1200,
    userMemoryChars: 600,
  };
}
