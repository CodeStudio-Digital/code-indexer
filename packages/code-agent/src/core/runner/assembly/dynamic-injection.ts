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
   * B1/G3 — ids of skills active THIS turn that were ALSO active in an earlier
   * turn (their bodies already shown to the model). After a recent compaction
   * the provider reminds the model NOT to re-run their one-time setup (the
   * summary dropped the evidence that it already ran). Empty/omitted = no
   * marker. Rendered only when `recentCompactionAt` indicates a recent compaction.
   */
  skillsAlreadyExecuted?: ReadonlyArray<string>;
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
  /** Host-ranked excerpts from immutable chapters in this same conversation. */
  relevantConversationChapters?: ReadonlyArray<{ id: string; title: string; content: string }>;
  lastInjectedConversationChapterIds?: ReadonlySet<string>;
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
  /** Session-scoped conversation chapter index (titles only). */
  conversationChapterIndex?: { text: string; hash: string } | null;
  lastInjectedConversationChapterIndexHash?: string | null;
  /**
   * Global user-preferences block (migration 145, pre-rendered) — who the user
   * is + how they want the agent to work, applied to EVERY project. Injected on
   * milestones (turn 1 / post-compaction) or when it changed, placed ABOVE the
   * project index (higher salience). Hash-gated so an unchanged block isn't
   * re-sent every turn (cache-safe tail block).
   */
  userMemoryIndex?: { text: string; hash: string } | null;
  lastInjectedUserMemoryHash?: string | null;
  /**
   * Task-preflight hint (pre-rendered `<preflight>` block) — the seed's
   * compass for the task. Injected on milestones (turn 1 / post-compaction)
   * or while not yet injected (hash mismatch). Content never changes
   * mid-session; the hash only guards double-injection. NOT gated by the
   * injection policy — the block is small and matters most on short windows.
   */
  preflightHint?: { text: string; hash: string } | null;
  lastInjectedPreflightHash?: string | null;
  /**
   * Correction nudge (assembly/correction-nudge.ts) — the user's last message
   * looked like a correction/durable preference, so suggest remember() NOW.
   * Already throttled by the Executing node (hash-gated per user message,
   * capped per session); non-null means "include this turn".
   */
  correctionHint?: string | null;
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
  /** Chapter ids included by selective conversation recall. */
  includedConversationChapterIds: string[];
  /** Hash of the session-state block included — caller stores for dedup. */
  includedSessionStateHash?: string | null;
  /** Hash of the project memory index included — caller stores for dedup. */
  includedProjectIndexHash?: string | null;
  /** Hash of the conversation chapter index included this turn. */
  includedConversationChapterIndexHash?: string | null;
  /** Hash of the user-preferences block included — caller stores for dedup. */
  includedUserMemoryHash?: string | null;
  /** Hash of the preflight hint included — caller stores for dedup. */
  includedPreflightHash?: string | null;
  /** True when the correction nudge was included — caller bumps its throttle. */
  includedCorrectionHint?: boolean;
}

const DEFAULT_MAX_FILES = 6;
const DEFAULT_MAX_MEMORY = 3;
const MEMORY_CONTENT_CAP = 300;
const CONVERSATION_CHAPTER_MAX = 2;
const CONVERSATION_CHAPTER_CONTENT_CAP = 400;

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

  const lastChapterIds = ctx.lastInjectedConversationChapterIds ?? new Set<string>();
  const includedConversationChapters: Array<{ id: string; title: string; content: string }> = [];
  for (const chapter of ctx.relevantConversationChapters ?? []) {
    if (includedConversationChapters.length >= CONVERSATION_CHAPTER_MAX) break;
    if (
      !lastChapterIds.has(chapter.id)
      && !includedConversationChapters.some((item) => item.id === chapter.id)
    ) {
      includedConversationChapters.push(chapter);
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
  const showConversationChapterIndex = !!ctx.conversationChapterIndex && (
    driveMilestone ||
    ctx.conversationChapterIndex.hash !== (ctx.lastInjectedConversationChapterIndexHash ?? null)
  );
  // User preferences — milestones, or when the block changed. Always-relevant
  // and small, so even minimal windows carry it (budget gated upstream).
  const showUserMemory = !!ctx.userMemoryIndex && (
    driveMilestone ||
    ctx.userMemoryIndex.hash !== (ctx.lastInjectedUserMemoryHash ?? null)
  );
  // Preflight hint — milestones, or while never injected yet.
  const showPreflight = !!ctx.preflightHint && (
    driveMilestone ||
    ctx.preflightHint.hash !== (ctx.lastInjectedPreflightHash ?? null)
  );

  if (
    includedSkillIds.length === 0 &&
    includedFiles.length === 0 &&
    includedMemory.length === 0 &&
    includedConversationChapters.length === 0 &&
    !showSessionState &&
    !showProjectIndex &&
    !showConversationChapterIndex &&
    !showUserMemory &&
    !showPreflight &&
    !recentCompaction &&
    !ctx.hasReviewableChanges &&
    !ctx.correctionHint
  ) {
    return null;
  }

  const lines: string[] = [];
  if (recentCompaction) {
    lines.push(
      `compaction occurred at turn ${ctx.recentCompactionAt}; older details were summarized — re-read files instead of recalling from memory.`,
    );
    const remindSkills = ctx.skillsAlreadyExecuted ?? [];
    if (remindSkills.length > 0) {
      lines.push(
        `skills already used earlier this session are shown again only for reference — do NOT re-run their one-time setup ` +
          `(auth, install, scheduling, file creation) unless the current task needs a fresh run: ${remindSkills.join(', ')}.`,
      );
    }
  }
  if (showPreflight && ctx.preflightHint) {
    lines.push(ctx.preflightHint.text);
  }
  if (ctx.correctionHint) {
    lines.push(ctx.correctionHint);
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
  if (includedConversationChapters.length > 0) {
    const excerpts = includedConversationChapters
      .map((chapter) => {
        const body = chapter.content.length > CONVERSATION_CHAPTER_CONTENT_CAP
          ? `${chapter.content.slice(0, CONVERSATION_CHAPTER_CONTENT_CAP)}…`
          : chapter.content;
        return `- ${chapter.title}: ${body.replace(/\s*\n\s*/g, ' ')}`;
      })
      .join('\n');
    lines.push(
      'relevant earlier conversation chapters (selective recall; use recall_conversation for full context/source):\n' +
      excerpts,
    );
  }
  if (showUserMemory && ctx.userMemoryIndex) {
    lines.push(ctx.userMemoryIndex.text);
  }
  if (showProjectIndex && ctx.projectMemoryIndex) {
    lines.push(ctx.projectMemoryIndex.text);
  }
  if (showConversationChapterIndex && ctx.conversationChapterIndex) {
    lines.push(ctx.conversationChapterIndex.text);
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
    includedConversationChapterIds: includedConversationChapters.map((chapter) => chapter.id),
    includedSessionStateHash: showSessionState ? ctx.sessionState!.hash : null,
    includedProjectIndexHash: showProjectIndex ? ctx.projectMemoryIndex!.hash : null,
    includedConversationChapterIndexHash: showConversationChapterIndex
      ? ctx.conversationChapterIndex!.hash
      : null,
    includedUserMemoryHash: showUserMemory ? ctx.userMemoryIndex!.hash : null,
    includedPreflightHash: showPreflight ? ctx.preflightHint!.hash : null,
    includedCorrectionHint: !!ctx.correctionHint,
  };
}

/** Convenience: wrap the reminder body in the `<system-reminder>` tag. */
export function formatDynamicInjection(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`;
}
