/**
 * B7 — pure decision core for the `qa_start_run` plan gate.
 *
 * Enforcement (not a new tool): a QA subordinate must have an APPROVED
 * plan (fast-path auto-approve counts) before it may create a test run.
 * The default is ON; the operator can disable it host-wide with
 * `MCP_QA_REQUIRE_PLAN=0`.
 *
 * Split from `qa-start-run.ts` so the rules stay unit-testable without
 * the tool handler's sandbox/store plumbing.
 */
import type { QaPlanGate } from '@mcp/services/qa/types.js';

/**
 * Pure: does `role` carry the `qa-playwright` skill in this session's
 * `config_json`? Tolerant of every malformed shape (missing roster,
 * bad JSON, non-array skills) — degrades to `false`, which SKIPS the
 * gate rather than false-refusing a non-QA subordinate.
 */
export function roleHasQaPlaywrightSkill(configJson: string, role: string): boolean {
  if (!configJson || !role) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return false;
  }
  const roles = (parsed as { role_assignments?: unknown } | null)?.role_assignments;
  if (!Array.isArray(roles)) return false;
  for (const entry of roles) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as { role?: unknown; skills?: unknown };
    if (r.role !== role) continue;
    return Array.isArray(r.skills) && r.skills.includes('qa-playwright');
  }
  return false;
}

export interface PlanGateInput {
  /** Raw `process.env.MCP_QA_REQUIRE_PLAN` ('0' disables the gate). */
  requirePlanEnv: string | undefined;
  /** True when the caller is a subordinate whose role has `qa-playwright`. */
  isQaSubordinate: boolean;
  /** Latest approval from `orchestrator.hasApprovedPlan(selfRunId)`. */
  approval: { approved: boolean; auto: boolean } | null;
}

export type PlanGateDecision =
  | { allowed: true; plan_gate: QaPlanGate | null }
  | { allowed: false; reason: string };

/** Agent-facing refusal — instructs the exact unblock path. */
export const PLAN_GATE_REFUSAL =
  'qa_start_run refused: no approved plan for this agent run. ' +
  'Submit your test plan first via submit_plan_to_master and wait for approval ' +
  '(plans are auto-approved by default unless this session disabled autonomy). ' +
  'Once the plan is approved, call qa_start_run again. ' +
  'Operators can disable this gate host-wide with MCP_QA_REQUIRE_PLAN=0.';

/**
 * Pure: decide whether the run may start and which `plan_gate` value to
 * persist on the row:
 *   - env '0'            → allowed, plan_gate='skipped' (gate disabled).
 *   - caller not QA-sub  → allowed, plan_gate=null (gate doesn't apply).
 *   - approval present   → allowed, plan_gate='auto' | 'approved'.
 *   - otherwise          → refused with `PLAN_GATE_REFUSAL`.
 */
export function resolvePlanGate(input: PlanGateInput): PlanGateDecision {
  if ((input.requirePlanEnv ?? '').trim() === '0') {
    return { allowed: true, plan_gate: 'skipped' };
  }
  if (!input.isQaSubordinate) {
    return { allowed: true, plan_gate: null };
  }
  if (input.approval?.approved) {
    return { allowed: true, plan_gate: input.approval.auto ? 'auto' : 'approved' };
  }
  return { allowed: false, reason: PLAN_GATE_REFUSAL };
}
