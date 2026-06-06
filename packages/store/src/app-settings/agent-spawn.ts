import type { SettingDef } from './types.js';

/**
 * Agent — spawn_agent per-type budgets (`SPAWN_LIMITS` in
 * packages/code-agent/src/tools/spawn-agent.ts). `*_MAX_TOOLS` is a budget of
 * tool *CALLS* (invocations), NOT the number of tools available. Read fresh on
 * every spawn → hot-apply (no restart). All advanced.
 */
export const AGENT_SPAWN_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_SPAWN_EXPLORE_MAX_TOOLS',
    label: 'spawn explore — tool-call budget',
    description:
      'Max tool CALLS for an `explore` spawn_agent subagent (read-only). 0 = unlimited (codex-style): ' +
      'it runs until it concludes or trips the timeout/stall guards, instead of cutting investigation short. Default 0.',
    type: 'int',
    category: 'agent',
    default: '0',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_EXPLORE_TIMEOUT_MS',
    label: 'spawn explore — wall-clock timeout (ms)',
    description: 'Hard timeout for an `explore` spawn_agent subagent. Default 600000 (10 min).',
    type: 'int',
    category: 'agent',
    default: '600000',
    min: 30_000,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_EXPLORE_STALL_MS',
    label: 'spawn explore — stall threshold (ms)',
    description: 'Abort an `explore` spawn_agent subagent after this long without semantic progress. Default 90000 (90s).',
    type: 'int',
    category: 'agent',
    default: '90000',
    min: 10_000,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_IMPLEMENT_MAX_TOOLS',
    label: 'spawn implement — tool-call budget',
    description:
      'Max tool CALLS for an `implement` spawn_agent subagent (read+write+shell). Bounds blast radius — ' +
      'it mutates. Hitting it stops with reason=tool_budget (benign partial result). Default 80.',
    type: 'int',
    category: 'agent',
    default: '80',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_IMPLEMENT_TIMEOUT_MS',
    label: 'spawn implement — wall-clock timeout (ms)',
    description: 'Hard timeout for an `implement` spawn_agent subagent. Default 1200000 (20 min).',
    type: 'int',
    category: 'agent',
    default: '1200000',
    min: 30_000,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_IMPLEMENT_STALL_MS',
    label: 'spawn implement — stall threshold (ms)',
    description: 'Abort an `implement` spawn_agent subagent after this long without progress. Default 120000 (2 min).',
    type: 'int',
    category: 'agent',
    default: '120000',
    min: 10_000,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_FULL_MAX_TOOLS',
    label: 'spawn full — tool-call budget',
    description:
      'Max tool CALLS for a `full` spawn_agent subagent (inherits the parent\'s exact toolset). Default 80.',
    type: 'int',
    category: 'agent',
    default: '80',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_FULL_TIMEOUT_MS',
    label: 'spawn full — wall-clock timeout (ms)',
    description: 'Hard timeout for a `full` spawn_agent subagent. Default 1200000 (20 min).',
    type: 'int',
    category: 'agent',
    default: '1200000',
    min: 30_000,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_FULL_STALL_MS',
    label: 'spawn full — stall threshold (ms)',
    description: 'Abort a `full` spawn_agent subagent after this long without progress. Default 120000 (2 min).',
    type: 'int',
    category: 'agent',
    default: '120000',
    min: 10_000,
    advanced: true,
  },
];
