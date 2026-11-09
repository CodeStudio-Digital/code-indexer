/**
 * Type + validation helpers for the `POST /api/company/sessions` body.
 *
 * Extracted from `sessions.ts` so the route file stays under the LOC cap.
 * `validateAllowedModels` is invoked from session create (rejects bad
 * pools) and from session config patch (PATCH /:id/config) — when the
 * latter moves out of `sessions.ts` it can import the same helper.
 */
import type { CompanyRoleConfig } from '@mcp/company/types.js';

export interface CreateSessionBody {
  template_id?: number;
  name: string;
  project_ids: number[];
  project_labels?: Record<number, string>;
  master_provider: string;
  master_model: string;
  role_assignments?: CompanyRoleConfig[];
  qa_executor?: 'preview' | 'playwright';
  /**
   * Curated pool of `(provider, model)` tuples the master is allowed
   * to spawn subordinates with. When present (length > 0), the master's
   * `spawn_subordinate_agent` tool will REFUSE models outside this
   * list; the tool error names the valid options so the master can
   * self-correct on retry. Absence preserves the previous free-form
   * behavior.
   */
  allowed_models?: Array<{
    provider: string;
    model: string;
    label?: string;
    notes?: string;
    is_default?: boolean;
  }>;
  /**
   * Phase B "master observer": when true, every peer-to-peer inbox
   * message also generates a fire-and-forget `notify` copy addressed
   * to the master so the orchestrator stays aware of inter-subordinate
   * traffic without gating it. Persisted under the same key in
   * `config_json` and read at runtime by `InboxQueue.send`.
   */
  master_broadcast_subscribe?: boolean;
  /**
   * Session-level operational rules (operator-authored, free-text markdown).
   * Persisted under `config_json.operational_rules` and injected VERBATIM into
   * the master and every subordinate system prompt at start/spawn/resume — the
   * single source of truth for cross-cutting policy (contract validation, no
   * local enum mapping, QA-vs-dev separation, self_review). Optional; absence
   * preserves the legacy session shape.
   */
  operational_rules?: string;
}

interface SessionProjectBindingCandidate {
  id: number;
  name: string;
  root_path: string;
  label?: string | null;
}

const PROJECT_HINT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  backend: ['backend', 'api', 'server'],
  frontend: ['frontend', 'front', 'web', 'client', 'public'],
  admin: ['admin', 'backoffice', 'console'],
};

function normalizedWords(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function projectMatchesHint(
  project: SessionProjectBindingCandidate,
  hint: string,
): boolean {
  const hintWords = normalizedWords(hint);
  if (hintWords.length === 0) return false;
  const hintPhrase = hintWords.join(' ');
  const aliases = new Set(
    hintWords.flatMap((word) => PROJECT_HINT_ALIASES[word] ?? [word]),
  );
  const fields = [
    project.label ?? '',
    project.name,
    project.root_path,
  ];
  for (const field of fields) {
    const words = normalizedWords(field);
    if (words.length === 0) continue;
    const phrase = words.join(' ');
    if (phrase === hintPhrase || phrase.includes(hintPhrase)) return true;
    if (words.some((word) => aliases.has(word))) return true;
  }
  return false;
}

/**
 * Turn reusable template `projectHints` into the concrete `projectIds` that
 * Company runtime enforcement consumes. Explicit bindings always win.
 * Unmatched hints remain visible and unbound so creation stays compatible
 * with generic templates instead of silently assigning the wrong project.
 */
export function resolveRoleProjectBindings(
  roles: readonly CompanyRoleConfig[],
  projects: readonly SessionProjectBindingCandidate[],
): CompanyRoleConfig[] {
  const selectedIds = new Set(projects.map((project) => project.id));
  return roles.map((role) => {
    if (Array.isArray(role.projectIds) && role.projectIds.length > 0) {
      return {
        ...role,
        projectIds: [...new Set(role.projectIds.filter((id) => selectedIds.has(id)))],
      };
    }
    if (!Array.isArray(role.projectHints) || role.projectHints.length === 0) {
      return { ...role };
    }
    const projectIds = projects
      .filter((project) =>
        role.projectHints!.some((hint) => projectMatchesHint(project, hint)),
      )
      .map((project) => project.id);
    return projectIds.length > 0
      ? { ...role, projectIds: [...new Set(projectIds)] }
      : { ...role };
  });
}

/**
 * Validate a proposed allowed_models pool + the derived session config:
 *   - Every entry has non-empty provider + model strings.
 *   - At most one entry is marked is_default.
 *   - If the list is non-empty, `master_model` MUST be one of the
 *     entries (otherwise the master can't run).
 *   - If `role_assignments` is also set, every role's (provider, model)
 *     MUST also be in the pool — we refuse to persist a template whose
 *     own assignments can't be spawned.
 */
export function validateAllowedModels(
  pool: NonNullable<CreateSessionBody['allowed_models']>,
  body: Partial<CreateSessionBody>,
): string | null {
  if (pool.length === 0) return null;
  let defaults = 0;
  for (const [i, entry] of pool.entries()) {
    if (!entry.provider?.trim() || !entry.model?.trim()) {
      return `allowed_models[${i}]: provider and model are required`;
    }
    if (entry.is_default) defaults++;
  }
  if (defaults > 1) {
    return `allowed_models has ${defaults} default entries — at most one may be default`;
  }
  const has = (p: string, m: string) =>
    pool.some((e) => e.provider === p && e.model === m);
  if (body.master_provider && body.master_model && !has(body.master_provider, body.master_model)) {
    return (
      `master model '${body.master_provider}/${body.master_model}' is not in allowed_models. ` +
      `Add it to the pool or pick one of: ${pool.map((e) => `${e.provider}/${e.model}`).join(', ')}`
    );
  }
  for (const role of body.role_assignments ?? []) {
    if (!has(role.provider, role.model)) {
      return (
        `role_assignments['${role.role}'] uses '${role.provider}/${role.model}' which is ` +
        `not in allowed_models. Every role must be spawn-able from the pool.`
      );
    }
  }
  return null;
}
