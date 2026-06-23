/**
 * Parse `CompanySession.config_json` into the runtime values
 * `MasterLifecycle` needs at start/resume time:
 *
 *   - `allowedModels`: curated (provider, model) pool the master may
 *     spawn subordinates with. Filters out malformed entries.
 *   - `roleConfigs`: persisted role assignments, merged with the
 *     in-memory list. Existing in-memory roles win — DB-only roles are
 *     appended so a partial `opts.roleConfigs` doesn't drop template
 *     entries.
 *
 * Pure parse function. The class method `MasterLifecycle.loadConfigFromDb`
 * delegates here, then assigns the returned values to its private state.
 * Failure paths return the unchanged input — same defensive contract the
 * inline code had (a corrupted `config_json` must not kill the master).
 */
import type { AllowedModel } from '@mcp/company/types.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';

export interface ParsedMasterConfig {
  allowedModels: AllowedModel[];
  roleConfigs: RoleConfig[];
}

/**
 * Merge the in-memory `currentRoleConfigs` with whatever the persisted
 * `config_json` carries. Existing roles win; DB-only roles are appended.
 * Returns the (possibly empty) parse result; never throws.
 */
export function parseMasterConfigFromDb(
  configJson: string | null | undefined,
  currentRoleConfigs: readonly RoleConfig[],
  sessionIdForLog: number | string,
): ParsedMasterConfig {
  const allowedModels: AllowedModel[] = [];
  const roleConfigs: RoleConfig[] = [...currentRoleConfigs];

  if (!configJson) return { allowedModels, roleConfigs };

  try {
    const cfg = JSON.parse(configJson) as {
      role_assignments?: RoleConfig[];
      allowed_models?: AllowedModel[];
    };
    if (Array.isArray(cfg.allowed_models)) {
      for (const m of cfg.allowed_models) {
        if (typeof m.provider === 'string' && typeof m.model === 'string') {
          allowedModels.push(m);
        }
      }
    }
    if (Array.isArray(cfg.role_assignments) && cfg.role_assignments.length > 0) {
      const seen = new Set(roleConfigs.map((r) => r.role));
      for (const r of cfg.role_assignments) {
        if (r && typeof r.role === 'string' && !seen.has(r.role)) {
          roleConfigs.push(r);
          seen.add(r.role);
        }
      }
    }
  } catch (e) {
    console.warn(
      `[master] config_json parse failed for session=${sessionIdForLog}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { allowedModels, roleConfigs };
}

/**
 * Read the optional session-level operational rules from `config_json`.
 *
 * Operator-authored, free-text markdown injected VERBATIM into the master
 * and every subordinate system prompt — the single source of truth for
 * cross-cutting policy (contract validation, no local enum mapping, QA vs
 * dev separation, self_review, …). Defensive: any parse failure or a
 * non-string / blank value yields `undefined`. Capped at a generous limit
 * so a pathological payload can't balloon the prompt; normal rule docs
 * (a few KB) pass through untouched.
 */
export function readOperationalRules(
  configJson: string | null | undefined,
): string | undefined {
  if (!configJson) return undefined;
  try {
    const cfg = JSON.parse(configJson) as { operational_rules?: unknown };
    const raw = cfg.operational_rules;
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const CAP = 16_000;
    return trimmed.length > CAP
      ? `${trimmed.slice(0, CAP)}\n\n…(truncated — operational rules exceeded ${CAP} chars)`
      : trimmed;
  } catch {
    return undefined;
  }
}
