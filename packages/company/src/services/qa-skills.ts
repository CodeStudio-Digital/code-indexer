
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
  const roles = (parsed as { role_assignments?: unknown }).role_assignments;
  if (!Array.isArray(roles)) return false;
  for (const role of roles) {
    if (!role || typeof role !== 'object') continue;
    const skills = (role as { skills?: unknown }).skills;
    if (!Array.isArray(skills)) continue;
    if (skills.some((s) => typeof s === 'string' && s === 'qa-playwright')) {
      return true;
    }
  }
  return false;
}
