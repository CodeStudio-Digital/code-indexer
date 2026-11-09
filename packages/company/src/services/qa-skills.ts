import { declaredRoleSkillIds } from '@mcp/company-contracts/qa-defaults.js';
/**
 * Pure: return `true` when at least one entry in the session config's
 * `role_assignments` carries the `qa-playwright` skill. Used by
 * `provisionIfNeeded` to flip `ProvisionRequest.includeE2e`, which in
 * turn picks the Chromium-capable image and triggers the Playwright
 * Agent CLI bootstrap inside the scaffolder.
 *
 * Tolerant of every malformed input shape. Exported for unit testing
 * without a store / DB.
 */
export function hasQaPlaywrightSkill(configJson: string): boolean {
  if (!configJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  // Explicit selection wins. Legacy qa-playwright teams keep their image;
  // new qa-preview teams do not pay for browser/regression dependencies.
  const executor = (parsed as { qa_executor?: unknown }).qa_executor;
  if (executor === 'preview') return false;
  if (executor === 'playwright') return true;
  const roles = (parsed as { role_assignments?: unknown }).role_assignments;
  if (!Array.isArray(roles)) return false;
  for (const role of roles) {
    if (!role || typeof role !== 'object') continue;
    const skills = (role as { skills?: unknown }).skills;
    if (declaredRoleSkillIds(skills).includes('qa-playwright')) {
      return true;
    }
  }
  return false;
}
