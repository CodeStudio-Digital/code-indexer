/**
 * Autonomy layer (C0) — per-session autonomy configuration.
 *
 * PURE module (no I/O, no store, no process globals beyond the injected
 * `env`). Resolves the effective `AutonomyConfig` for a company session
 * with the precedence:
 *
 *   `config_json.autonomy.*` (when present AND valid)
 *     > matching env var
 *       > default
 *
 * C2 — ORGANISM DEFAULTS: the company runs autonomously OUT OF THE BOX.
 * Every default below is ON; envs became KILL-SWITCHES (not opt-ins):
 *
 *   - scheduler     → default ON. `MCP_COMPANY_SCHEDULER='0'` turns it off
 *                     ('1' still turns it on — back-compat no-op).
 *   - orphanReset   → follows the scheduler default (same env gate).
 *   - autoApprove   → default `'*'` (every role self-approves). When the
 *                     env `MCP_COMPANY_AUTO_APPROVE_ROLES` is PRESENT it
 *                     overrides — including an explicit empty string,
 *                     which means OFF (nobody self-approves).
 *   - supervisor    → default ON. `MCP_SUPERVISOR_MASTER='0'` turns it off.
 *   - maxSubordinates → default 8. Env `MCP_COMPANY_GLOBAL_MAX_SUBORDINATES`:
 *                     int>0 = cap, '0' = UNCAPPED (no limit), absent/blank
 *                     or invalid = default 8.
 *
 * Session-side `config_json.autonomy.*` overrides everything (precedence
 * unchanged); `freeze: true` live-kills every autonomous action.
 *
 * Parsing is 100% defensive, same contract as
 * `services/master/config-loader.ts`: a corrupted `config_json` (or a
 * wrongly-typed individual field) must never throw — invalid fields are
 * ignored INDIVIDUALLY and fall back to env/default.
 */
import type { KanbanColumn } from '@mcp/company/types.js';

/** Real kanban column key ('backlog' | 'todo' | 'in_progress' | 'review' | 'done'). */
export type KanbanColumnKey = KanbanColumn;

export const KANBAN_COLUMN_KEYS: readonly KanbanColumnKey[] = [
  'backlog', 'todo', 'in_progress', 'review', 'done',
];

export interface AutonomyConfig {
  /** Organism: autonomous dispatch loop (CompanyScheduler ticks). */
  scheduler: boolean;
  /** Reset of orphaned in_progress cards in the reconciler sweep. */
  orphanReset: boolean;
  /** Roles whose plans self-approve. `'*'` = all, `null` = off. */
  autoApproveRoles: string[] | '*' | null;
  /** Supervisor watching the master. */
  supervisorMaster: boolean;
  /**
   * Global subordinate budget as seen by THIS session. `number` = cap,
   * `null` = UNCAPPED (only reachable via env `'0'` — a session cannot
   * disable the cap, it can only pick a different positive number).
   */
  maxSubordinates: number | null;
  /** WIP limit per kanban column. Empty record = no limits. */
  wipLimits: Partial<Record<KanbanColumnKey, number>>;
  /** Kill-switch: when true every autonomous action is denied (see helper). */
  freeze: boolean;
}

export type AutonomyAction = 'scheduler' | 'autoApprove' | 'supervisor' | 'orphanReset';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * C2 default-ON boolean env: the flag is a KILL-SWITCH. `'0'`/`'false'`/
 * `'off'` (case-insensitive) turn the feature off; anything else — absent,
 * blank (the `vi.stubEnv('X','')` testing idiom), `'1'` (legacy opt-in,
 * kept as a back-compat no-op) — leaves it on.
 */
function envFlagDefaultOn(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

/**
 * C2 default: env ABSENT → `'*'` (every role self-approves). A PRESENT env
 * overrides — an explicit empty/blank string means OFF (`null`), a csv is
 * the allowlist, `'*'` is all.
 */
function parseRolesEnvValue(raw: string | undefined): string[] | '*' | null {
  if (raw === undefined) return '*';
  if (!raw.trim()) return null;
  const trimmed = raw.trim();
  if (trimmed === '*') return '*';
  const roles = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  return roles.length > 0 ? roles : null;
}

export const DEFAULT_MAX_SUBORDINATES = 8;

/**
 * C2 global-budget env semantics:
 *   absent / blank / invalid → default 8
 *   `'0'`                    → `null` = UNCAPPED (the only way to lift the cap)
 *   int > 0                  → that cap
 */
function parseMaxSubordinatesEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_SUBORDINATES;
  const trimmed = raw.trim();
  if (trimmed === '0') return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_SUBORDINATES;
}

/**
 * Session-side roles value. `null` (explicit off), `'*'`, or an array —
 * non-string entries inside the array are dropped individually. Any other
 * shape → `undefined` (ignored, falls through to env/default).
 */
function parseRolesSessionValue(v: unknown): string[] | '*' | null | undefined {
  if (v === null) return null;
  if (v === '*') return '*';
  if (Array.isArray(v)) {
    return v
      .filter((r): r is string => typeof r === 'string')
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return undefined;
}

/** Session-side wipLimits: keep only known columns with integer > 0 values. */
function parseWipLimitsValue(
  v: unknown,
): Partial<Record<KanbanColumnKey, number>> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Partial<Record<KanbanColumnKey, number>> = {};
  for (const col of KANBAN_COLUMN_KEYS) {
    const n = v[col];
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[col] = n;
  }
  return out;
}

/** Defensive extraction of `config_json.autonomy` — bad JSON/shape → null. */
function readAutonomyObject(
  configJson: string | null | undefined,
): Record<string, unknown> | null {
  if (!configJson) return null;
  try {
    const cfg: unknown = JSON.parse(configJson);
    if (!isPlainObject(cfg)) return null;
    return isPlainObject(cfg.autonomy) ? cfg.autonomy : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective autonomy config for a session.
 *
 * `freeze` does NOT alter the other fields here — consumers decide what a
 * frozen session may still do (via `isAutonomyActionAllowed`).
 */
export function resolveAutonomy(
  configJson: string | null | undefined,
  env: NodeJS.ProcessEnv,
): AutonomyConfig {
  // C2 — organism defaults: ON unless the env kill-switch says otherwise.
  const schedulerOn = envFlagDefaultOn(env.MCP_COMPANY_SCHEDULER);
  const cfg: AutonomyConfig = {
    scheduler: schedulerOn,
    // The reconciler's orphan-card sweep rides the SAME gate as the scheduler
    // — resetting cards only makes sense paired with the loop that re-picks them.
    orphanReset: schedulerOn,
    autoApproveRoles: parseRolesEnvValue(env.MCP_COMPANY_AUTO_APPROVE_ROLES),
    supervisorMaster: envFlagDefaultOn(env.MCP_SUPERVISOR_MASTER),
    maxSubordinates: parseMaxSubordinatesEnv(env.MCP_COMPANY_GLOBAL_MAX_SUBORDINATES),
    wipLimits: {},
    freeze: false,
  };

  const autonomy = readAutonomyObject(configJson);
  if (!autonomy) return cfg;

  if (typeof autonomy.scheduler === 'boolean') cfg.scheduler = autonomy.scheduler;
  if (typeof autonomy.orphanReset === 'boolean') cfg.orphanReset = autonomy.orphanReset;
  if ('autoApproveRoles' in autonomy) {
    const roles = parseRolesSessionValue(autonomy.autoApproveRoles);
    if (roles !== undefined) cfg.autoApproveRoles = roles;
  }
  if (typeof autonomy.supervisorMaster === 'boolean') {
    cfg.supervisorMaster = autonomy.supervisorMaster;
  }
  if ('maxSubordinates' in autonomy) {
    const v = autonomy.maxSubordinates;
    // C2 semantics: session int>0 overrides the cap FOR THIS SESSION.
    // Explicit `null` = "back to default policy" (env/default resolution
    // above stands) — it does NOT mean "no limit"; only the env `'0'`
    // lifts the cap. Invalid values are ignored individually.
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) cfg.maxSubordinates = v;
  }
  const wip = parseWipLimitsValue(autonomy.wipLimits);
  if (wip !== undefined) cfg.wipLimits = wip;
  if (typeof autonomy.freeze === 'boolean') cfg.freeze = autonomy.freeze;

  return cfg;
}

/**
 * Coarse action gate: `freeze` wins over everything; otherwise the action
 * maps to its config field. `autoApprove` requires a non-empty role list
 * (or `'*'`) — `null` and `[]` both mean "nobody self-approves".
 */
export function isAutonomyActionAllowed(cfg: AutonomyConfig, action: AutonomyAction): boolean {
  if (cfg.freeze) return false;
  switch (action) {
    case 'scheduler': return cfg.scheduler;
    case 'autoApprove':
      return cfg.autoApproveRoles === '*'
        || (Array.isArray(cfg.autoApproveRoles) && cfg.autoApproveRoles.length > 0);
    case 'supervisor': return cfg.supervisorMaster;
    case 'orphanReset': return cfg.orphanReset;
  }
}
