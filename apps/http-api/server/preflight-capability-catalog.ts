/**
 * Builds the FULL capability surface the task-preflight analyzer reasons over:
 * native tools + external MCP server tools + active skills. Kept out of deps.ts
 * (a god-file) so the merge/cap logic stays small and testable.
 *
 * Fail-open by construction: any failure degrades to the native catalog / an
 * empty skill list, never throws — preflight is best-effort.
 */
import { enumerateExternalTools } from '../admin/mcp-servers.routes.js';
import { deriveSkillNamespace } from '@mcp/code-agent/skills/namespace.js';
import type { SkillStore } from '@mcp/store/skill-store.js';
import type {
  PreflightSkillMeta,
  PreflightToolMeta,
} from '@mcp/services/services/task-preflight/index.js';

const DEFAULT_EXT_CATALOG_MAX = 40;
const DEFAULT_SKILLS_MAX = 30;

// 0 is honored (means "show none") so each cap doubles as a kill-switch for
// external-tool / skill exposure while preflight keeps seeding profile/pins/
// memories. Negatives and NaN fall back to the default.
function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Merge the static native/tier catalog with cached external MCP tools.
 * Native names win on collision (an external server can't shadow a native
 * tool). External tools are sorted by name and capped so an over-large MCP
 * server can't blow the analyzer's prompt budget.
 */
export function buildPreflightToolCatalog(
  dbPath: string,
  nativeMeta: PreflightToolMeta[],
  enumerate: typeof enumerateExternalTools = enumerateExternalTools,
): PreflightToolMeta[] {
  try {
    const nativeNames = new Set(nativeMeta.map((t) => t.name));
    const external = enumerate(dbPath).tools
      .filter((t) => !nativeNames.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, envInt('CODER_PREFLIGHT_EXT_CATALOG_MAX', DEFAULT_EXT_CATALOG_MAX))
      .map((t) => ({ name: t.name, tier: t.tier, description: t.description }));
    return external.length > 0 ? [...nativeMeta, ...external] : nativeMeta;
  } catch {
    return nativeMeta;
  }
}

/**
 * Active skills for the session (project-scoped + session overrides), shaped
 * for the analyzer: id + description + namespace. Capped to bound prompt cost.
 */
export function buildPreflightSkillCatalog(
  skillStore: SkillStore,
  sessionId: number,
  projectId: number,
): PreflightSkillMeta[] {
  try {
    return skillStore
      .resolveActiveSkills(sessionId, projectId)
      .slice(0, envInt('CODER_PREFLIGHT_SKILLS_MAX', DEFAULT_SKILLS_MAX))
      .map((s) => ({
        id: s.id,
        description: s.description,
        namespace: deriveSkillNamespace(s),
      }));
  } catch {
    return [];
  }
}
