/**
 * Per-turn message assembly. Extracted from the legacy runner closure so
 * the BT's `Executing` node can call this directly without re-deriving
 * `this`-bound state.
 *
 * Steps (identical to the legacy `assembleMessagesForChat`):
 *   1. Apply `compactHistoryForLLM` — rolling reduction + char compaction.
 *   2. Build `<active_skills>` + `<active-context>` blocks (via callbacks
 *      so the caller can keep `this`-bound helpers intact for now).
 *   3. Append the extras onto the trailing user message (or push a new
 *      user message if the tail is assistant/tool).
 */
import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import type { CoderTunables } from '@mcp/code-agent/core/tunables.js';
import type { CompactionLimits } from '@mcp/code-agent/core/compaction.js';
import { compactHistoryForLLM } from './compact-history.js';
import { formatDynamicInjection, type DynamicInjectionResult } from './dynamic-injection.js';

export interface AssembleMessagesArgs {
  /** Full history as held by the runner. NOT mutated. */
  messages: AgentMessage[];
  /** Session tunables — flow through to `compactHistoryForLLM`. */
  tunables: CoderTunables;
  /** Char-based compaction limits (legacy path). Undefined => token path. */
  compactionLimits: CompactionLimits | undefined;
  /** When true, the `<active-context>` callback fires (Agent Loop v2). */
  agentLoopV2: boolean;
  /**
   * Callback that resolves the `<active_skills>` block off the trailing
   * user message of the COMPACTED history. Returns null when nothing to
   * inject. Side-effects (`skill.usage` bundle events) are the caller's.
   */
  buildActiveSkillsBlock: (compactedHistory: AgentMessage[]) => string | null;
  /**
   * Callback that builds the `<active-context>` block from live runner
   * state (goal, tasks, todos). Returns null when nothing to inject.
   */
  buildActiveContextBlock: () => string | null;
  /**
   * PR-F: optional callback returning a Kimi-style dynamic injection
   * (skill diff, recently-edited files, compaction marker). Wrapped in
   * `<system-reminder>` and appended to the trailing user message ALONG
   * WITH active_skills + active-context. Returns null when nothing to
   * inject (most turns). The runner is responsible for tracking which
   * skills/files have already been included so the same content doesn't
   * appear twice — see `dynamic-injection.ts`.
   */
  computeDynamicInjection?: () => DynamicInjectionResult | null;
  /** Rolling-reducer stats observer for per-turn telemetry (mig 143). */
  onReducerStats?: (s: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number }) => void;
}

export function assembleMessagesForChat(args: AssembleMessagesArgs): AgentMessage[] {
  const compacted = compactHistoryForLLM(
    args.messages,
    args.compactionLimits,
    args.tunables,
    args.onReducerStats,
  );

  const activeSkillsBlock = args.buildActiveSkillsBlock(compacted);
  const activeContextBlock = args.agentLoopV2 ? args.buildActiveContextBlock() : null;
  const dynamicInjection = args.computeDynamicInjection?.() ?? null;

  if (!activeSkillsBlock && !activeContextBlock && !dynamicInjection) return compacted;

  const extras: ContentBlock[] = [];
  // Skills go BEFORE active-context so the model treats them as fresh
  // user-authored instructions framing the current goal, instead of
  // reading the live goal first and then second-guessing it.
  if (activeSkillsBlock) extras.push({ type: 'text', text: activeSkillsBlock });
  if (activeContextBlock) extras.push({ type: 'text', text: activeContextBlock });
  // PR-F dynamic injection comes LAST — closest to the user message so
  // the model treats it as the freshest signal about what changed since
  // the last turn. Wrapped in `<system-reminder>` so it visually
  // differs from active_skills / active-context which target distinct
  // axes of context.
  if (dynamicInjection) {
    extras.push({ type: 'text', text: formatDynamicInjection(dynamicInjection.reminder) });
  }

  const cloned = compacted.slice();
  const lastIdx = cloned.length - 1;
  if (lastIdx >= 0 && cloned[lastIdx].role === 'user') {
    const last = cloned[lastIdx];
    cloned[lastIdx] = {
      role: 'user',
      content: [...last.content, ...extras],
    };
  } else {
    cloned.push({ role: 'user', content: extras });
  }
  return cloned;
}
