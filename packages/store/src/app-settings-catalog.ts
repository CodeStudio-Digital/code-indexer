/**
 * App settings catalog — the curated list of `process.env.*` knobs we expose
 * in the admin "Configurações" panel.
 *
 * This file is the BARREL: it composes the per-category modules under
 * `./app-settings/` into the single `APP_SETTINGS` array and re-exports the
 * types + helpers. The public import path is unchanged, so every consumer
 * (store, admin routes, the dashboard, the i18n generator) keeps working.
 *
 * Add a new env:
 *   1. Drop a `SettingDef` into the right `./app-settings/<category>.ts` module.
 *   2. Make sure the reader tolerates an empty string (cleared field → '').
 *   3. Set `restartNeeded: true` if it needs more than `process.env[K] = v`.
 *   4. Run `pnpm tsx scripts/gen-settings-i18n.ts` to sync the i18n namespace.
 *
 * NOT in this catalog (by design):
 *   - Provider API keys + base URLs (live in the Providers panel).
 *   - SDK internals (`CLAUDE_CODE_*`) — owned by the @anthropic SDK.
 *   - OS / Node basics (`NODE_ENV`, `CI`, `PATH`, `AWS_REGION`).
 */
export type { SettingType, SettingCategory, SettingDef } from './app-settings/types.js';
export { SETTING_CATEGORIES } from './app-settings/types.js';

import type { SettingDef } from './app-settings/types.js';
import { LLM_SETTINGS } from './app-settings/llm.js';
import { MCP_SETTINGS } from './app-settings/mcp.js';
import { AGENT_BEHAVIOUR_SETTINGS } from './app-settings/agent-behaviour.js';
import { AGENT_GUARD_SETTINGS } from './app-settings/agent-guards.js';
import { AGENT_OUTPUT_SETTINGS } from './app-settings/agent-output.js';
import { AGENT_SPAWN_SETTINGS } from './app-settings/agent-spawn.js';
import { AGENT_TASK_SETTINGS } from './app-settings/agent-tasks.js';
import { COMPANY_SETTINGS } from './app-settings/company.js';
import { COMPANY_SUPERVISOR_SETTINGS } from './app-settings/company-supervisor.js';
import { NOTIFICATION_SETTINGS } from './app-settings/notifications.js';
import { MEMORY_SETTINGS } from './app-settings/memory.js';
import { DEBUG_SETTINGS } from './app-settings/debug.js';
import { INDEXING_SETTINGS } from './app-settings/indexing.js';
import { SANDBOX_SETTINGS } from './app-settings/sandbox.js';
import { GIT_IDENTITY_SETTINGS } from './app-settings/git-identity.js';

// These owners retain a worker, timer or manager across operations. Publishing
// process.env cannot reconfigure existing instances; a restart recreates them.
const RESTART_SETTINGS = new Set([
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'MCP_CODER_WORKER_DEBUG', 'MCP_CODER_WORKER_STRICT_CRASH',
  'CODER_WORKER_TTL_MS', 'CODER_WORKER_POST_RUN_LINGER_MS',
  'MCP_MAX_SANDBOXES', 'MCP_SANDBOX_IDLE_MS', 'MCP_SANDBOX_PAUSE_AFTER_MS',
  'MCP_SANDBOX_DESTROY_AFTER_PAUSE_MS', 'MCP_SANDBOX_STATS_MS', 'MCP_SANDBOX_AUTO_IDLE_REAPER',
  'MCP_MEMORY_SWEEPER', 'MCP_MEMORY_IDLE_AFTER_MS', 'MCP_MEMORY_CONSOLIDATE',
  'MCP_MEMORY_CONSOLIDATE_INTERVAL_MS', 'MCP_MEMORY_CONSOLIDATE_IDLE_MS', 'MCP_MEMORY_CONSOLIDATE_MAX_PROJECTS',
  'MCP_MEMORY_MERGE_COSINE', 'MCP_MEMORY_MERGE_TITLE_JACCARD', 'MCP_MEMORY_MAX_MERGES_PER_PASS',
  'MCP_MEMORY_MAX_SNAPSHOTS_PER_PASS', 'MCP_MEMORY_ARCHIVE_IMPORTANCE_MAX',
  'MCP_MEMORY_ARCHIVE_UNUSED_DAYS', 'MCP_MEMORY_ARCHIVE_MAX_ACCESS',
  'CODER_COMPANY_ORCHESTRATOR_TTL_MS', 'MCP_COMPANY_INBOX_WATCHDOG_ENABLED',
  'MCP_COMPANY_INBOX_WATCHDOG_INTERVAL_MS', 'MCP_COMPANY_INBOX_WATCHDOG_STUCK_MS',
  'MCP_LSP_WORKER_IDLE_MS',
]);

export const APP_SETTINGS: readonly SettingDef[] = [
  ...LLM_SETTINGS,
  ...MCP_SETTINGS,
  ...INDEXING_SETTINGS,
  ...SANDBOX_SETTINGS,
  ...AGENT_BEHAVIOUR_SETTINGS,
  ...AGENT_GUARD_SETTINGS,
  ...AGENT_OUTPUT_SETTINGS,
  ...AGENT_SPAWN_SETTINGS,
  ...AGENT_TASK_SETTINGS,
  ...GIT_IDENTITY_SETTINGS,
  ...COMPANY_SETTINGS,
  ...COMPANY_SUPERVISOR_SETTINGS,
  ...NOTIFICATION_SETTINGS,
  ...MEMORY_SETTINGS,
  ...DEBUG_SETTINGS,
].map((def) => RESTART_SETTINGS.has(def.key) ? { ...def, restartNeeded: true } : def);

/** Index-by-key lookup for O(1) access during SettingStore reads. */
const BY_KEY = new Map<string, SettingDef>(APP_SETTINGS.map((d) => [d.key, d]));

export function getSettingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}
