/**
 * Dynamic context injection provider (PR-F, Kimi-style).
 *
 * Inspired by kimi-cli's `_DynamicInjectionProvider`: every turn, look
 * at runtime state (skills registered since last turn, files edited
 * recently, whether compaction just happened) and inject a synthesized
 * `system-reminder` block near the end of the conversation. The
 * provider is REACTIVE — it produces nothing when nothing changed,
 * which is most turns.
 *
 * Placement is cache-friendly: the reminder is added as the LAST
 * content block of the trailing user message (or appended as a fresh
 * user message if the tail is assistant/tool). The system prompt +
 * tools array — the actual prefix the provider caches — is never
 * touched.
 *
 * This module is intentionally pure. The runner's `Executing` node
 * calls `computeDynamicInjection(ctx)` and (when non-null) hands the
 * result to `assembleMessagesForChat` via the `injectedSystemReminder`
 * hook. The runner is also responsible for tracking which skills /
 * files have already been injected — pass them through `lastInjected`.
 */

export interface DynamicInjectionContext {
  /** Current turn index (1-based). Used to decide "recent". */
  turn: number;
  /**
   * Skills registered or refreshed THIS SESSION but not yet seen in a
   * synthesized reminder. Provider includes them ONCE in the next
   * reminder, then expects the runner to update `lastInjectedSkillIds`.
   */
  newlyRegisteredSkillIds: ReadonlyArray<string>;
  /**
   * Names of skills already injected in prior reminders. Anything in
   * `newlyRegisteredSkillIds` and also in this set is treated as
   * "stale notification" — skipped.
   */
  lastInjectedSkillIds: ReadonlySet<string>;
  /**
   * Files the agent edited in the last N turns that the agent's own
   * context window may not still hold. Caller decides N; the provider
   * surfaces up to `maxActiveFiles` of them.
   */
  recentlyEditedFiles: ReadonlyArray<string>;
  /** Files already mentioned in a prior reminder — skipped. */
  lastInjectedFiles: ReadonlySet<string>;
  /**
   * True when compaction occurred within the last 2 turns. When set,
   * the provider emits a "context was summarized" notice so the model
   * knows older detail was dropped intentionally.
   */
  recentCompactionAt?: number | null;
  /** Limit on file names included per reminder. Default 6. */
  maxActiveFiles?: number;
  /**
   * Relevant project memory retrieved for this turn (already relevance-gated
   * + ranked by the caller — the provider only formats + dedupes). Each item
   * is a durable memory/snapshot worth surfacing for the current task.
   */
  relevantMemory?: ReadonlyArray<{ id: string; title: string; content: string; staleNote?: string }>;
  /** Memory ids already injected in prior reminders — skipped. */
  lastInjectedMemoryIds?: ReadonlySet<string>;
  /** Limit on memory items per reminder. Default 3. */
  maxMemoryItems?: number;
  /**
   * True when the session has active (un-kept/un-reverted) file snapshots AND
   * the CODER_SELF_REVIEW toggle is on. Surfaces a one-line `self_review`
   * reminder. Intentionally NOT deduped — recomputed every turn so it persists
   * while changes are pending (most importantly on the "I'm done" turn).
   */
  hasReviewableChanges?: boolean;
  /**
   * Session State Block (`assembly/session-state.ts`) — the always-alive
   * structured state of the session (goal/plan/todos/notes/files/recall),
   * pre-rendered by the Executing node. Subsumes the old per-field drive
   * injection (activePlan / sessionMemory / investigation nudge):
   *   - standard windows: injected on turn 1, ≤2 turns post-compaction, or
   *     whenever the block's hash changed (a note was added, a todo moved…).
   *   - short windows (`sessionStateEveryTurn`): injected EVERY turn — the
   *     block is what keeps a small model oriented after compaction.
   */
  sessionState?: { block: string; hash: string } | null;
  sessionStateEveryTurn?: boolean;
  lastInjectedSessionStateHash?: string | null;
  /**
   * Project memory index (MEMORY.md-style one-liners, pre-rendered) —
   * injected on milestones (turn 1 / post-compaction) or when it changed.
   */
  projectMemoryIndex?: { text: string; hash: string } | null;
  lastInjectedProjectIndexHash?: string | null;
  /**
   * Test-mode escape hatch — when true, the provider always returns
   * null so snapshot tests don't see non-deterministic injections.
   */
  testMode?: boolean;
}

export interface DynamicInjectionResult {
  /** The body text to wrap as `<system-reminder>...</system-reminder>`. */
  reminder: string;
  /** Skill IDs that were included — caller adds to `lastInjectedSkillIds`. */
  includedSkillIds: string[];
  /** Files that were included — caller adds to `lastInjectedFiles`. */
  includedFiles: string[];
  /** Memory ids that were included — caller adds to `lastInjectedMemoryIds`. */
  includedMemoryIds: string[];
  /** Hash of the session-state block included — caller stores for dedup. */
  includedSessionStateHash?: string | null;
  /** Hash of the project memory index included — caller stores for dedup. */
  includedProjectIndexHash?: string | null;
}

const DEFAULT_MAX_FILES = 6;
const DEFAULT_MAX_MEMORY = 3;
const MEMORY_CONTENT_CAP = 300;

/**
 * Compute the dynamic injection for the next turn. Returns null when
 * there's nothing to inject (most turns) so the caller can short-circuit.
 *
 * Deterministic given identical inputs — tests can pin the output
 * exactly.
 */
export function computeDynamicInjection(
  ctx: DynamicInjectionContext,
): DynamicInjectionResult | null {
  if (ctx.testMode) return null;

  const includedSkillIds: string[] = [];
  for (const id of ctx.newlyRegisteredSkillIds) {
    if (!ctx.lastInjectedSkillIds.has(id) && !includedSkillIds.includes(id)) {
      includedSkillIds.push(id);
    }
  }

  const maxFiles = Math.max(0, ctx.maxActiveFiles ?? DEFAULT_MAX_FILES);
  const includedFiles: string[] = [];
  for (const f of ctx.recentlyEditedFiles) {
    if (includedFiles.length >= maxFiles) break;
    if (!ctx.lastInjectedFiles.has(f) && !includedFiles.includes(f)) {
      includedFiles.push(f);
    }
  }

  const maxMemory = Math.max(0, ctx.maxMemoryItems ?? DEFAULT_MAX_MEMORY);
  const lastMemoryIds = ctx.lastInjectedMemoryIds ?? new Set<string>();
  const includedMemory: Array<{ id: string; title: string; content: string; staleNote?: string }> = [];
  for (const m of ctx.relevantMemory ?? []) {
    if (includedMemory.length >= maxMemory) break;
    if (!lastMemoryIds.has(m.id) && !includedMemory.some((x) => x.id === m.id)) {
      includedMemory.push(m);
    }
  }

  const recentCompaction = ctx.recentCompactionAt != null && (ctx.turn - ctx.recentCompactionAt) <= 2;

  // Session State Block — every turn on short windows; on milestones (turn 1
  // / post-compaction) or whenever the block materially changed otherwise.
  const driveMilestone = recentCompaction || ctx.turn === 1;
  const showSessionState = !!ctx.sessionState && (
    ctx.sessionStateEveryTurn === true ||
    driveMilestone ||
    ctx.sessionState.hash !== (ctx.lastInjectedSessionStateHash ?? null)
  );
  // Project memory index — milestones, or when the index itself changed.
  const showProjectIndex = !!ctx.projectMemoryIndex && (
    driveMilestone ||
    ctx.projectMemoryIndex.hash !== (ctx.lastInjectedProjectIndexHash ?? null)
  );

  if (
    includedSkillIds.length === 0 &&
    includedFiles.length === 0 &&
    includedMemory.length === 0 &&
    !showSessionState &&
    !showProjectIndex &&
    !recentCompaction &&
    !ctx.hasReviewableChanges
  ) {
    return null;
  }

  const lines: string[] = [];
  if (recentCompaction) {
    lines.push(
      `compaction occurred at turn ${ctx.recentCompactionAt}; older details were summarized — re-read files instead of recalling from memory.`,
    );
  }
  if (includedSkillIds.length > 0) {
    lines.push(`skills registered this session and worth consulting: ${includedSkillIds.join(', ')}`);
  }
  if (includedFiles.length > 0) {
    const truncated = ctx.recentlyEditedFiles.length > includedFiles.length
      ? ` (+${ctx.recentlyEditedFiles.length - includedFiles.length} more truncated)`
      : '';
    lines.push(`recently edited files (may not be in your current context): ${includedFiles.join(', ')}${truncated}`);
  }
  if (includedMemory.length > 0) {
    const items = includedMemory
      .map((m) => {
        const body = m.content.length > MEMORY_CONTENT_CAP
          ? `${m.content.slice(0, MEMORY_CONTENT_CAP)}…`
          : m.content;
        const stale = m.staleNote ? ` (may be stale: ${m.staleNote})` : '';
        return `- ${m.title}: ${body.replace(/\s*\n\s*/g, ' ')}${stale}`;
      })
      .join('\n');
    lines.push(`relevant project memory (retrieved — verify against current code before relying on it):\n${items}`);
  }
  if (showProjectIndex && ctx.projectMemoryIndex) {
    lines.push(ctx.projectMemoryIndex.text);
  }
  if (showSessionState && ctx.sessionState) {
    lines.push(ctx.sessionState.block);
  }
  if (ctx.hasReviewableChanges) {
    lines.push(
      'this session has pending file changes — before you tell the user the work is done, call ' +
        '`self_review` to validate them with the configured review pipeline, then apply or dismiss each finding.',
    );
  }

  return {
    reminder: lines.join('\n'),
    includedSkillIds,
    includedFiles,
    includedMemoryIds: includedMemory.map((m) => m.id),
    includedSessionStateHash: showSessionState ? ctx.sessionState!.hash : null,
    includedProjectIndexHash: showProjectIndex ? ctx.projectMemoryIndex!.hash : null,
  };
}

/** Convenience: wrap the reminder body in the `<system-reminder>` tag. */
export function formatDynamicInjection(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`;
}
