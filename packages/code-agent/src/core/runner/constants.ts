/**
 * Module-level tunable constants and small helpers for the runner's
 * loop-guard family. Resolved at module load from `process.env.CODER_*`
 * with documented defaults. Read once per session — for late-binding
 * test overrides (`vi.stubEnv`), prefer the lazy `envInt` helpers
 * exported from `dup-utils.ts` / `recovery-config.ts`.
 *
 * Owns: doom-loop / dup-call / dup-result / polling / summarizer /
 * push-time-cap / per-turn budget knobs.
 */

/** Module-load env reader for non-lazy numeric tunables. */
function readEnvInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * Lazy env reader so tests can override these caps after module import
 * (`vi.stubEnv` works because we re-resolve every call rather than
 * capturing at module load).
 */
export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * Doom-loop guard: if the model emits the exact same set of tool calls
 * this many turns in a row, abort the run. Prevents cost blowups when a
 * model latches onto a failing tool call and keeps retrying it verbatim.
 * Set to 0 (or any N<2) to disable. Default 3 matches opencode's
 * processor.ts.
 *
 * Default 3 (was 0/disabled): a real session that hit `get_goal`
 * repeatedly 30+ times burned through tokens with no guard. Strict-sig
 * threshold of 3 is conservative — only triggers on byte-identical
 * tool calls.
 */
export function doomLoopThreshold(): number {
  return envInt('CODER_DOOM_LOOP_THRESHOLD', 3);
}

/**
 * Unrestricted-mode push-time caps. When the per-session
 * `unrestrictedToolOutput` toggle is on, the runner bumps the
 * effective per-tool-result cap to these ceilings instead of the
 * default tunables. Auto-compaction still fires, so very large
 * outputs (Unity console dumps, MCP search hits) arrive intact in
 * the turn that produced them.
 */
export const UNRESTRICTED_PUSH_TIME_CAP = readEnvInt('CODER_UNRESTRICTED_PUSH_TIME_CAP', 1_000_000);
export const UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP = readEnvInt(
  'CODER_UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP',
  500_000,
);

/** Per-turn safety budget — emits a warning when the about-to-send payload exceeds this. */
export const TURN_BUDGET_CHARS = readEnvInt('CODER_TURN_BUDGET_CHARS', 30_000);

/**
 * Fuzzy doom-loop threshold: catches "same tool names, slightly different args"
 * patterns that the strict signature misses. Higher than the strict threshold
 * because the false-positive risk is larger.
 *
 * Default 6 (was 0): more tolerant than strict, still catches the
 * "model paginates the same file 6+ turns" pattern.
 */
export const DOOM_LOOP_FUZZY_THRESHOLD = readEnvInt('CODER_DOOM_LOOP_FUZZY_THRESHOLD', 6);

/**
 * Tools the FUZZY doom-loop (name-only) is allowed to watch.
 *
 * Fuzzy fires on "same tool name N-of-M turns regardless of args/result" —
 * which is a LOOP for session-state churn (create_goal with rotating text,
 * status spam, re-submitting plans) but NORMAL for productive work: reading,
 * editing, or searching DIFFERENT files 6× in a row is exploration /
 * refactoring, not a loop. gpt-5.5 emits 1 tool/turn, so 6 reads = 6 turns —
 * fuzzy would false-fire constantly without this scope.
 *
 * So fuzzy is restricted to this small allowlist; everything else (reads,
 * edits, search, exec, file ops) is exempt from fuzzy. The PRECISE guards
 * still cover those: strict doom-loop (identical args), tuple-hash / pre-read
 * (identical call / same slice), failure-streak (consecutive errors), and the
 * dominance guard (one tool, 15+ turns, ZERO assistant text). A new tool
 * defaults to NOT being fuzzy-watched — the safe direction (no false
 * positives; a genuine new churn-loop still hits strict/dominance).
 */
export const FUZZY_LOOP_TOOLS: ReadonlySet<string> = new Set<string>([
  'create_goal',
  'update_goal',
  'get_goal',
  'set_agent_status',
  'submit_plan',
  'submit_plan_to_master',
  'task_list',
  'submit_tasks',
  'submit_tasks_to_master',
  // Track-gate aliases of task_list: include so a varied-checklist loop
  // (re-writing the list each refused turn with a tweak) still accumulates and
  // escalates to a Planning turn instead of slipping past as "diverse usage".
  'todo_write',
  'update_todo',
  'expand_toolset',
  'find_tools',
]);

/**
 * PR 5 — fuzzy doom-loop tolerance window.
 *
 * The legacy fuzzy check fired only when ALL last `THRESHOLD` signatures
 * matched. Session 798's `write_stdin` loop had 5-8s of provider-chat
 * between failures (occasionally a no-tool turn). That intercalated
 * reasoning reset the buffer before the fuzzy window could close.
 *
 * The new check counts MATCHES in the trailing window and fires when
 * `matches >= THRESHOLD - TOLERANCE`. Default tolerance is
 * `floor(THRESHOLD / 3)` (2 for the default 6 ⇒ requires 4-of-6).
 *
 * Env override: `CODER_DOOM_LOOP_FUZZY_TOLERANCE` (integer, clamped
 * to `[0, THRESHOLD - 2]`).
 */
export function doomLoopFuzzyTolerance(threshold: number): number {
  const raw = process.env.CODER_DOOM_LOOP_FUZZY_TOLERANCE;
  const defaultTol = Math.floor(threshold / 3);
  if (raw == null || raw === '') return defaultTol;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return defaultTol;
  // Need at least 2 matches to claim a loop.
  return Math.min(Math.floor(n), Math.max(0, threshold - 2));
}

/**
 * Dominance guard (`guards/dominance.ts`). Catches one tool eating a long
 * window of turns with ZERO assistant text — the silent-grind runaway
 * (session 609: 50+ turns of `mcp__read_file`, no narration). Lazy readers so
 * tests can override via `vi.stubEnv`. Kill switch: `CODER_DOMINANCE=0`.
 *
 *   - window: turns inspected (default 15).
 *   - ratio:  fraction of the window a single tool must own (default 0.8).
 */
export function dominanceWindow(): number {
  return envInt('CODER_DOMINANCE_WINDOW', 15);
}
export function dominanceRatio(): number {
  const v = process.env.CODER_DOMINANCE_RATIO;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  }
  return 0.8;
}

/**
 * Opt-in debug logging for the 3 doom-loop guards (strict, fuzzy,
 * dominance) + the dup-call cap. When `CODER_DOOM_LOOP_DEBUG=1` every
 * push, reset, and check writes a structured `[doom-loop-debug]` line.
 * Zero overhead when off.
 */
export const DEBUG_DOOM_LOOP = process.env.CODER_DOOM_LOOP_DEBUG === '1';

/**
 * Per-arg duplicate-call cap (Fix F — session 609 regression). Default
 * 5: balances "agent legitimately re-reads after editing" (1–2 calls)
 * against "agent stuck rotating chunks" (>>5).
 */
export const DUP_CALL_THRESHOLD = readEnvInt('CODER_DUP_CALL_THRESHOLD', 5);
export const DUP_CALL_WINDOW = readEnvInt('CODER_DUP_CALL_WINDOW', 20);

/**
 * Polling-tool name pattern — convention-based auto-detection of tools
 * where repeated identical-args calls are the LEGITIMATE workflow, not
 * a stuck-loop signal. Prefix matches at start-of-name or after `__`
 * separator. Suffix matches at end-of-name.
 *
 * Tools that match OR have `CoderTool.repeatable===true` are exempt
 * from: dup-call cap, strict/fuzzy doom-loop guards, dominance guard,
 * and post-call result-content dedup.
 */
export const REPEATABLE_NAME_PATTERN =
  /(?:^|__)(?:wait_for|await|poll|tail|monitor|list)_|_(?:status|logs|pulse|stats)$/;

/**
 * Agent Loop v2 result-content dedup. Refuses a tool result that has the
 * same byte content as a previous result from the same tool within the
 * window. Threshold = how many earlier matches in the window before the
 * NEXT call gets refused.
 */
export const RESULT_DUP_THRESHOLD = readEnvInt('CODER_RESULT_DUP_THRESHOLD', 1);
export const RESULT_DUP_WINDOW = readEnvInt('CODER_RESULT_DUP_WINDOW', 15);
export const RESULT_DUP_MIN_CHARS = readEnvInt('CODER_RESULT_DUP_MIN_CHARS', 50);

/**
 * Mode selector for dup-result behaviour: 'escalate' (default — three
 * tiers: light marker → warn marker → hard refuse), 'marker' (always
 * marker, never refuse — legacy), or 'refuse' (refuse from the first
 * duplicate — oldest behaviour, not recommended).
 */
export const RESULT_DUP_MODE: 'escalate' | 'marker' | 'refuse' = (() => {
  const v = (process.env.CODER_RESULT_DUP_MODE ?? 'escalate').toLowerCase();
  if (v === 'refuse') return 'refuse';
  if (v === 'marker') return 'marker';
  return 'escalate';
})();

/**
 * Escalation thresholds — `matches.length` values (NOT hit counts) at
 * which the next tier kicks in. `_WARN` (default 2) = 3rd fetch gets
 * warn marker. `_REFUSE` (default 3) = 4th+ fetch hard refuse.
 */
export const RESULT_DUP_ESCALATION_WARN = readEnvInt('CODER_RESULT_DUP_ESCALATION_WARN', 2);
export const RESULT_DUP_ESCALATION_REFUSE = readEnvInt('CODER_RESULT_DUP_ESCALATION_REFUSE', 3);

/**
 * Polling-tool caps (Phase C). Polling tools are exempt from the 4
 * main guards but get their own brake: soft cap injects a reminder
 * into the result content, hard cap refuses the call.
 */
export const REPEATABLE_SOFT_CAP = readEnvInt('CODER_REPEATABLE_SOFT_CAP', 20);
export const REPEATABLE_HARD_CAP = readEnvInt('CODER_REPEATABLE_HARD_CAP', 60);
export const REPEATABLE_WINDOW = readEnvInt('CODER_REPEATABLE_WINDOW', 30);

/**
 * Polling-result stuck cap. Even legitimate polling SHOULD see state
 * evolve. When the RESULT content is byte-identical for N polls in a
 * row, the polling is stuck and the agent is wasting tokens.
 */
export const POLLING_STUCK_CAP = readEnvInt('CODER_POLLING_STUCK_CAP', 10);
export const POLLING_STUCK_MIN_CHARS = readEnvInt('CODER_POLLING_STUCK_MIN_CHARS', 50);

/**
 * Reminder tier for the standard dup-call-cap (non-polling tools).
 * Calls 3-4 get a `<system-reminder>` appended; call 5+ refuses.
 */
export const DUP_CALL_REMINDER_THRESHOLD = readEnvInt('CODER_DUP_CALL_REMINDER_THRESHOLD', 3);

/**
 * PR 5 (failure-streak guard) — per-tool consecutive-failure counters.
 *
 * Gap caught in session 798: 13 `write_stdin` calls failed in 0ms each
 * because the LLM rotated `session_id` between calls. Tuple-hash dedup
 * saw 13 unique keys, doom-loop-fuzzy got reset by intercalated no-tool
 * turns, and `isError=true` was invisible to every existing guard.
 *
 * `failure-streak` counts consecutive `isError=true` results per tool
 * name. Threshold `REMINDER` prepends a sharp marker to the next result
 * ("you've failed N×; LIST sessions / RE-READ the error / change tactic").
 * Threshold `REFUSE` replaces the result with a hard refusal and emits
 * `ToolLoopDetected{guard:'failure-streak'}` so the BT routes to
 * Planning. A single successful call resets the streak.
 *
 * Tools matching `REPEATABLE_NAME_PATTERN` are exempt — for polling
 * primitives a string of empty results is the workflow, not a loop.
 */
export const FAILURE_STREAK_REMINDER_THRESHOLD = readEnvInt('CODER_FAILURE_STREAK_REMINDER', 3);
export const FAILURE_STREAK_REFUSE_THRESHOLD = readEnvInt('CODER_FAILURE_STREAK_REFUSE', 5);

/**
 * Phase B — summarizer pass cap + cooldown. Up to `MAX_RUNS` LLM
 * summarizer passes per session with at least `COOLDOWN_TURNS` between
 * consecutive passes. MAX_RUNS=1 restores legacy lock-once; MAX_RUNS=0
 * disables the summarizer entirely.
 */
export const SUMMARIZER_MAX_RUNS = readEnvInt('CODER_SUMMARIZER_MAX_RUNS', 6);
export const SUMMARIZER_COOLDOWN_TURNS = readEnvInt('CODER_SUMMARIZER_COOLDOWN_TURNS', 8);

/**
 * Above this character count, the dup-result marker switches to
 * "medium" mode: head excerpt + pointer to persisted output_id
 * instead of inlining the full duplicate.
 */
export const RESULT_DUP_LARGE_THRESHOLD = readEnvInt('CODER_RESULT_DUP_LARGE_THRESHOLD', 8000);

/** Length of the head excerpt embedded in the medium marker. */
export const RESULT_DUP_HEAD_CHARS = readEnvInt('CODER_RESULT_DUP_HEAD_CHARS', 400);

/**
 * Pure helper exported for testability. Returns true when the LLM
 * summarizer is allowed to run on this turn given the per-session
 * count + cooldown budget.
 *
 * Rules:
 *   - `maxRuns <= 0` disables the summarizer entirely (returns false).
 *   - The first eligible run (runCount === 0) always passes the
 *     cooldown — `lastTurn` is `-Infinity` initially.
 *   - Subsequent runs require `turn - lastTurn >= cooldownTurns`.
 */
export function canRunSummarizer(args: {
  runCount: number;
  lastTurn: number;
  currentTurn: number;
  maxRuns: number;
  cooldownTurns: number;
}): boolean {
  if (args.maxRuns <= 0) return false;
  if (args.runCount >= args.maxRuns) return false;
  if (args.runCount === 0) return true;
  return args.currentTurn - args.lastTurn >= args.cooldownTurns;
}

/**
 * Fix A — stop PUSHING the `self_review` nudge after this many auto-reviews
 * this session. The `self_review` TOOL stays available; we just stop the
 * per-turn reminder that amplifies the review→fix→review doom-loop
 * (session 887). `<= 0` disables the cap. Lazy reader for `vi.stubEnv`.
 */
export function selfReviewMaxNudges(): number {
  return envInt('CODER_SELF_REVIEW_MAX', 3);
}
