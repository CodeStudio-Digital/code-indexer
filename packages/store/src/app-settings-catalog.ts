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
import { DEBUG_SETTINGS } from './app-settings/debug.js';
import { INDEXING_SETTINGS } from './app-settings/indexing.js';

export const APP_SETTINGS: readonly SettingDef[] = [
  ...LLM_SETTINGS,
  ...MCP_SETTINGS,
  ...INDEXING_SETTINGS,
  ...AGENT_BEHAVIOUR_SETTINGS,
  ...AGENT_GUARD_SETTINGS,
  ...AGENT_OUTPUT_SETTINGS,
  ...AGENT_SPAWN_SETTINGS,
  ...AGENT_TASK_SETTINGS,
  ...COMPANY_SETTINGS,
  ...DEBUG_SETTINGS,
];

/** Index-by-key lookup for O(1) access during SettingStore reads. */
const BY_KEY = new Map<string, SettingDef>(APP_SETTINGS.map((d) => [d.key, d]));

export function getSettingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}
