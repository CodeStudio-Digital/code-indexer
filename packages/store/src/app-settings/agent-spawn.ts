import type { SettingDef } from './types.js';

/**
 * Agent — spawn_agent per-type budgets. `*_MAX_TOOLS` is a budget of
 * tool *CALLS* (invocations), NOT the number of tools available. Read fresh on
 * every spawn → hot-apply (no restart). All advanced.
 *
 * Layering (per axis): the per-profile override in the Providers panel wins
 * over these env values; unset env falls through to the automatic default —
 * 2x the research-depth soft target for explore/review (quick 32 calls/6 min,
 * standard 80/14, deep 160/24, exhaustive 320/50), flat caps otherwise
 * (implement/full 150 calls/30 min, verify 80/15, no-policy explore/review
 * 80/14). Explicit 0 anywhere = unlimited.
 */
export const AGENT_SPAWN_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_SPAWN_EXPLORE_MAX_TOOLS',
    label: 'spawn explore — tool-call budget',
    description:
      'Max tool CALLS for an `explore` spawn_agent subagent (read-only). Unset = automatic ' +
      '(2x the research-depth soft target: 32/80/160/320; 80 without a policy). 0 = unlimited. ' +
      'The per-profile override in the Providers panel wins over this env.',
    type: 'int',
    category: 'agent',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_EXPLORE_TIMEOUT_MS',
    label: 'spawn explore — wall-clock timeout (ms)',
    description:
      'Hard timeout for an `explore` subagent. Unset = automatic (2x the depth soft time target, ' +
      'e.g. deep = 24 min; 14 min without a policy). 0 = unlimited. Providers-panel override wins.',
    type: 'int',
    category: 'agent',
    min: 0,
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
      'Max tool CALLS for an `implement` spawn_agent subagent. Unset = automatic (150). 0 = unlimited. ' +
      'A positive cap stops with a resumable partial result. Providers-panel override wins.',
    type: 'int',
    category: 'agent',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_IMPLEMENT_TIMEOUT_MS',
    label: 'spawn implement — wall-clock timeout (ms)',
    description:
      'Hard timeout for an `implement` subagent. Unset = automatic (1800000 = 30 min). ' +
      '0 = unlimited. Providers-panel override wins.',
    type: 'int',
    category: 'agent',
    min: 0,
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
    key: 'CODER_SPAWN_VERIFY_MAX_TOOLS',
    label: 'spawn verify — tool-call budget',
    description:
      'Max tool CALLS for a `verify` subagent. Unset = automatic (80). 0 = unlimited. ' +
      'Providers-panel override wins.',
    type: 'int', category: 'agent', min: 0, advanced: true,
  },
  {
    key: 'CODER_SPAWN_VERIFY_TIMEOUT_MS',
    label: 'spawn verify — wall-clock timeout (ms)',
    description:
      'Hard timeout for a `verify` subagent. Unset = automatic (900000 = 15 min). 0 = unlimited. ' +
      'Providers-panel override wins.',
    type: 'int', category: 'agent', min: 0, advanced: true,
  },
  {
    key: 'CODER_SPAWN_VERIFY_STALL_MS',
    label: 'spawn verify — stall threshold (ms)',
    description: 'Abort a `verify` subagent after 120000ms without semantic progress.',
    type: 'int', category: 'agent', default: '120000', min: 10_000, advanced: true,
  },
  {
    key: 'CODER_SPAWN_REVIEW_MAX_TOOLS',
    label: 'spawn review — tool-call budget',
    description:
      'Max tool CALLS for a `review` subagent. Unset = automatic (2x the depth soft target, ' +
      'like explore; 80 without a policy). 0 = unlimited. Providers-panel override wins.',
    type: 'int', category: 'agent', min: 0, advanced: true,
  },
  {
    key: 'CODER_SPAWN_REVIEW_TIMEOUT_MS',
    label: 'spawn review — wall-clock timeout (ms)',
    description:
      'Hard timeout for a `review` subagent. Unset = automatic (2x the depth soft time target; ' +
      '14 min without a policy). 0 = unlimited. Providers-panel override wins.',
    type: 'int', category: 'agent', min: 0, advanced: true,
  },
  {
    key: 'CODER_SPAWN_REVIEW_STALL_MS',
    label: 'spawn review — stall threshold (ms)',
    description: 'Abort a `review` subagent after 120000ms without semantic progress.',
    type: 'int', category: 'agent', default: '120000', min: 10_000, advanced: true,
  },
  {
    key: 'CODER_SPAWN_FULL_MAX_TOOLS',
    label: 'spawn full — tool-call budget',
    description:
      'Max tool CALLS for a `full` spawn_agent subagent. Unset = automatic (150). 0 = unlimited. ' +
      'Providers-panel override wins.',
    type: 'int',
    category: 'agent',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_FULL_TIMEOUT_MS',
    label: 'spawn full — wall-clock timeout (ms)',
    description:
      'Hard timeout for a `full` subagent. Unset = automatic (1800000 = 30 min). 0 = unlimited. ' +
      'Providers-panel override wins.',
    type: 'int',
    category: 'agent',
    min: 0,
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
