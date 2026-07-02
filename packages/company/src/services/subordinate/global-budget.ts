/**
 * Global subordinate budget (C2) — PURE decision logic, extracted from
 * `spawn.ts` so the semantics are testable without the spawn's I/O.
 *
 * Semantics (decided in the C2 default-flip):
 *   - The COUNT is GLOBAL cross-session (every company worker shares the
 *     same SQLite file — `countActiveSubordinatesGlobal()`), but the CAP is
 *     resolved from the CALLING session's autonomy config. Each spawn checks
 *     the global count against its OWN session's cap: a session with
 *     `autonomy.maxSubordinates: 12` may keep spawning after a default-cap
 *     (8) session was refused. That is intentional — the cap is a per-session
 *     policy about how much of the machine that session may consume.
 *   - `cap === null` means UNCAPPED. Only the env kill-switch
 *     `MCP_COMPANY_GLOBAL_MAX_SUBORDINATES='0'` produces it; a session
 *     cannot lift the cap (session `null` = "back to default policy" — see
 *     `resolveAutonomy`). Default cap when nothing is configured: 8.
 *   - `countActive` is a thunk so the (cheap but real) DB count is skipped
 *     entirely when uncapped.
 */

export type GlobalBudgetVerdict =
  | { ok: true }
  | { ok: false; message: string };

export function checkGlobalSubordinateBudget(args: {
  /** Resolved `AutonomyConfig.maxSubordinates` of the SPAWNING session. */
  cap: number | null;
  /** Lazy global count — only invoked when a cap applies. */
  countActive: () => number;
}): GlobalBudgetVerdict {
  if (args.cap === null) return { ok: true };
  const active = args.countActive();
  if (active < args.cap) return { ok: true };
  return {
    ok: false,
    message:
      `spawnSubordinate refused: global subordinate budget reached ` +
      `(${active}/${args.cap} active across all company sessions; cap from this ` +
      `session's autonomy config — default 8, override via autonomy.maxSubordinates ` +
      `or MCP_COMPANY_GLOBAL_MAX_SUBORDINATES, '0' = uncapped). ` +
      `Wait for another session's agents to finish before spawning more.`,
  };
}
