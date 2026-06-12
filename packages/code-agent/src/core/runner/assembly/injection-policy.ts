/**
 * Injection policy — how much session-state to inject, and how often,
 * scaled by the model's effective context window.
 *
 *   - standard (>64k): milestone injection (turn 1, post-compaction, or
 *     the block changed). Plenty of window; keep the tail lean.
 *   - short (≤64k): inject the state block EVERY turn (~275 tok). With a
 *     small window the summarizer is the only other continuity thread —
 *     this block is what keeps the model oriented after aggressive
 *     compaction. Tail-only, so the cached prefix is untouched.
 *   - minimal (≤16k): every turn, but skeletal.
 *
 * Env knobs: `CODER_SESSION_STATE=0` kills the block entirely;
 * `CODER_SHORT_WINDOW_TOKENS` moves the short threshold (default 64k).
 */
import { getEffectiveContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { SessionStateBudget } from './session-state.js';

export type InjectionMode = 'standard' | 'short' | 'minimal';

export interface InjectionPolicy {
  mode: InjectionMode;
  /** False when CODER_SESSION_STATE=0 — no state block, no memory index. */
  enabled: boolean;
  /** True → the block is injected every turn (short/minimal windows). */
  stateEveryTurn: boolean;
  budget: SessionStateBudget;
  /** Char budget for the project memory index (0 = off). */
  memoryIndexChars: number;
}

const MINIMAL_WINDOW_TOKENS = 16_000;
const DEFAULT_SHORT_WINDOW_TOKENS = 64_000;

function shortWindowThreshold(): number {
  const raw = process.env.CODER_SHORT_WINDOW_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SHORT_WINDOW_TOKENS;
}

function sessionStateEnabled(): boolean {
  const raw = process.env.CODER_SESSION_STATE;
  if (raw == null || raw === '') return true;
  const v = raw.toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

export function resolveInjectionPolicy(
  model: string,
  opts: {
    /** True when `<active-context>` (Agent Loop v2) already carries
     *  goal/todos every turn — the state block then omits them. */
    liveStateCovered?: boolean;
  } = {},
): InjectionPolicy {
  const enabled = sessionStateEnabled();
  const effective = getEffectiveContextWindow(model).effective;
  const includeLiveState = !opts.liveStateCovered;

  if (effective <= MINIMAL_WINDOW_TOKENS) {
    return {
      mode: 'minimal',
      enabled,
      stateEveryTurn: true,
      budget: {
        planChars: 120, goalChars: 160, noteSlots: 1, noteChars: 120,
        todoLines: 3, fileSlots: 0, includeLiveState,
      },
      memoryIndexChars: 0,
    };
  }

  if (effective <= shortWindowThreshold()) {
    return {
      mode: 'short',
      enabled,
      stateEveryTurn: true,
      budget: {
        planChars: 280, goalChars: 200, noteSlots: 2, noteChars: 160,
        todoLines: 5, fileSlots: 3, includeLiveState,
      },
      memoryIndexChars: 400,
    };
  }

  return {
    mode: 'standard',
    enabled,
    stateEveryTurn: false,
    budget: {
      planChars: 700, goalChars: 300, noteSlots: 4, noteChars: 280,
      todoLines: 8, fileSlots: 6, includeLiveState,
    },
    memoryIndexChars: 1200,
  };
}
