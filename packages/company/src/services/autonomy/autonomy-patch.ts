/**
 * Autonomy layer (C0) — PATCH-side validation + merge for the `autonomy`
 * object inside `company_sessions.config_json`.
 *
 * PURE module shared by:
 *   - `apps/http-api` PATCH /api/company/sessions/:id/config (validates the
 *     body and merges directly when the session is not running), and
 *   - `CompanyOrchestrator.applyConfigPatch` (merges inside the worker for a
 *     running session, then publishes `session.config_updated`).
 *
 * Contract differs from `resolveAutonomy` on purpose: the RESOLVE side is
 * silently defensive (bad fields fall back to env/default), while the PATCH
 * side REJECTS wrongly-typed known fields with a message — an operator
 * typo should surface as a 400, not vanish. Unknown top-level keys are
 * ignored; unknown wipLimits columns are dropped silently.
 */
import {
  KANBAN_COLUMN_KEYS,
  isPlainObject,
  type AutonomyConfig,
  type KanbanColumnKey,
} from './autonomy-config.js';

/** Partial update — only the keys present in the request are touched. */
export type AutonomyPatch = Partial<AutonomyConfig>;

export type SanitizeAutonomyResult =
  | { ok: true; patch: AutonomyPatch }
  | { ok: false; error: string };

const BOOL_KEYS = ['scheduler', 'orphanReset', 'supervisorMaster', 'freeze'] as const;

/**
 * Validate an untrusted `autonomy` body into a typed patch.
 * Known keys with invalid types → error; unknown keys → ignored.
 */
export function sanitizeAutonomyPatch(input: unknown): SanitizeAutonomyResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'autonomy must be an object' };
  }
  const patch: AutonomyPatch = {};

  for (const key of BOOL_KEYS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (typeof v !== 'boolean') {
      return { ok: false, error: `autonomy.${key} must be a boolean` };
    }
    patch[key] = v;
  }

  if ('autoApproveRoles' in input) {
    const v = input.autoApproveRoles;
    if (v === null || v === '*') {
      patch.autoApproveRoles = v;
    } else if (Array.isArray(v) && v.every((r) => typeof r === 'string')) {
      patch.autoApproveRoles = v.map((r) => r.trim()).filter(Boolean);
    } else {
      return {
        ok: false,
        error: "autonomy.autoApproveRoles must be an array of strings, '*', or null",
      };
    }
  }

  if ('maxSubordinates' in input) {
    const v = input.maxSubordinates;
    if (v === null) patch.maxSubordinates = null;
    else if (typeof v === 'number' && Number.isInteger(v) && v > 0) patch.maxSubordinates = v;
    else {
      return { ok: false, error: 'autonomy.maxSubordinates must be an integer > 0 or null' };
    }
  }

  if ('wipLimits' in input) {
    const v = input.wipLimits;
    if (!isPlainObject(v)) {
      return { ok: false, error: 'autonomy.wipLimits must be an object' };
    }
    const wip: Partial<Record<KanbanColumnKey, number>> = {};
    for (const col of KANBAN_COLUMN_KEYS) {
      if (!(col in v)) continue;
      const n = v[col];
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `autonomy.wipLimits.${col} must be an integer > 0` };
      }
      wip[col] = n;
    }
    patch.wipLimits = wip; // unknown column keys are dropped silently
  }

  return { ok: true, patch };
}

/**
 * Shallow per-key merge of a sanitized patch over whatever the persisted
 * `config_json.autonomy` currently holds. A corrupted / non-object previous
 * value is treated as empty rather than propagated.
 */
export function mergeAutonomyPatch(
  existing: unknown,
  patch: AutonomyPatch,
): Record<string, unknown> {
  const prev = isPlainObject(existing) ? existing : {};
  return { ...prev, ...patch };
}
