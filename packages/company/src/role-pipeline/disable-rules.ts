/**
 * SubordinateDisableRule (C2 — Sprint 1).
 *
 * Declarative skip-rules attached to a `RoleDescriptor`. Direct port of
 * the `DISABLE_RULES` pattern from `grox/tasks/task.py` (xai-org/x-algorithm):
 * each task class declares a list of rule classes; before execution the
 * Task asks every rule "should I disable myself?" and short-circuits if any
 * returns true.
 *
 * **Why declarative vs imperative**: today the orchestrator has scattered
 * conditionals like "if frontend skipped, skip QA too". Moving these into
 * the Role descriptor itself means the rule is co-located with the role
 * it applies to — easier to audit, easier to test, easier to compose.
 *
 * **Backward compat**: `RoleDescriptor.disableRules` is optional. Absent
 * → `DisableRulesFilter` is a no-op for that candidate (kept) — bit-
 * identical to pre-C2 behavior. Existing `BlockedRolesFilter` (which
 * takes a list of role names) keeps working unchanged.
 *
 * **Composition**: rules run in declaration order; the first rule whose
 * `shouldDisable` returns true wins. `reason()` is called only on the
 * winning rule and surfaced in pipeline diagnostics.
 */

/**
 * Live workflow state passed alongside the role candidate. Fields are
 * optional — when omitted the rule receives an empty Set (treated as
 * "no signal yet").
 */
export interface SubordinateDisableContext {
  /** The task text being routed. */
  taskText: string;
  /** Roles that have been intentionally skipped earlier in this workflow. */
  skippedRoles: ReadonlySet<string>;
  /** Roles that previously failed in this workflow (post-retry). */
  failedRoles: ReadonlySet<string>;
  /** Roles that are currently running (already spawned). */
  runningRoles: ReadonlySet<string>;
}

/** Build an empty context — useful as the default when callers don't pass one. */
export function emptyDisableContext(taskText = ''): SubordinateDisableContext {
  return {
    taskText,
    skippedRoles: new Set(),
    failedRoles: new Set(),
    runningRoles: new Set(),
  };
}

export interface SubordinateDisableRule {
  /** Human-readable name surfaced in pipeline diagnostics. */
  readonly name: string;
  /** Return true to DISABLE the role (skip spawning it for this task). */
  shouldDisable(ctx: SubordinateDisableContext): boolean;
  /** Human-readable explanation — only invoked when shouldDisable returns true. */
  reason(ctx: SubordinateDisableContext): string;
}

// ─── Pre-built rules ──────────────────────────────────────────────────

/**
 * Disable if any of the named roles was previously SKIPPED in this workflow.
 *
 * Example: `skipIfRolesSkipped(['frontend'])` on a QA role means
 * "don't run QA if frontend was skipped" — common DAG semantics where
 * downstream work is pointless without an upstream artifact.
 */
export function skipIfRolesSkipped(roleNames: string[]): SubordinateDisableRule {
  const set = new Set(roleNames);
  const list = roleNames.join(', ');
  return {
    name: `skipIfRolesSkipped(${list})`,
    shouldDisable(ctx): boolean {
      for (const r of ctx.skippedRoles) if (set.has(r)) return true;
      return false;
    },
    reason(ctx): string {
      const matched = [...ctx.skippedRoles].filter((r) => set.has(r));
      return `upstream role(s) ${matched.join(', ')} were skipped`;
    },
  };
}

/**
 * Disable if any of the named roles FAILED in this workflow. Combine with
 * `skipIfRolesSkipped` to express "run only when the upstream actually
 * succeeded" — the strict DAG variant.
 */
export function skipIfAnyRoleFailed(roleNames: string[]): SubordinateDisableRule {
  const set = new Set(roleNames);
  const list = roleNames.join(', ');
  return {
    name: `skipIfAnyRoleFailed(${list})`,
    shouldDisable(ctx): boolean {
      for (const r of ctx.failedRoles) if (set.has(r)) return true;
      return false;
    },
    reason(ctx): string {
      const matched = [...ctx.failedRoles].filter((r) => set.has(r));
      return `upstream role(s) ${matched.join(', ')} failed`;
    },
  };
}

/**
 * Disable if a matching role is already running. Useful for singleton
 * roles (only one master-arch at a time). Different from `CapacityFilter`,
 * which checks numeric capacity from `RoleDescriptor.concurrencyCap` —
 * this is a binary "any instance present" check.
 */
export function skipIfRoleAlreadyRunning(roleName: string): SubordinateDisableRule {
  return {
    name: `skipIfRoleAlreadyRunning(${roleName})`,
    shouldDisable(ctx): boolean {
      return ctx.runningRoles.has(roleName);
    },
    reason(): string {
      return `role ${roleName} already has a running instance`;
    },
  };
}

// ─── Evaluation ───────────────────────────────────────────────────────

export interface DisableRuleEvaluation {
  disabled: boolean;
  ruleName?: string;
  reason?: string;
}

/**
 * Run all rules in declaration order; return the first match. When no
 * rule matches, returns `{ disabled: false }`. Pure function, no side
 * effects — used by `DisableRulesFilter` and unit tests.
 */
export function evaluateDisableRules(
  rules: ReadonlyArray<SubordinateDisableRule> | undefined,
  ctx: SubordinateDisableContext,
): DisableRuleEvaluation {
  if (!rules || rules.length === 0) return { disabled: false };
  for (const rule of rules) {
    if (rule.shouldDisable(ctx)) {
      return { disabled: true, ruleName: rule.name, reason: rule.reason(ctx) };
    }
  }
  return { disabled: false };
}
