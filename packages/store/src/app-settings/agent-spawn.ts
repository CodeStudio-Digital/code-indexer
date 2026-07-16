import type { SettingDef } from './types.js';

/**
 * Agent — spawn_agent per-type budgets. `*_MAX_TOOLS` is a budget of
 * tool *CALLS* (invocations), NOT the number of tools available. Read fresh on
 * every spawn → hot-apply (no restart). All advanced.
 */
export const AGENT_SPAWN_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_SPAWN_EXPLORE_MAX_TOOLS',
    label: 'spawn explore — tool-call budget',
    description:
      'Max tool CALLS for an `explore` spawn_agent subagent (read-only). 0 = unlimited (codex-style): ' +
      'it runs until it concludes or trips a real liveness guard. Default 0.',
    type: 'int',
    category: 'agent',
    default: '0',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_EXPLORE_TIMEOUT_MS',
    label: 'spawn explore — wall-clock timeout (ms)',
    description: 'Optional hard timeout for an `explore` subagent. 0 = unlimited. Default 0.',
    type: 'int',
    category: 'agent',
    default: '0',
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
      'Max tool CALLS for an `implement` spawn_agent subagent. 0 = unlimited. ' +
      'A positive cap stops with a resumable partial result. Default 0.',
    type: 'int',
    category: 'agent',
    default: '0',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_IMPLEMENT_TIMEOUT_MS',
    label: 'spawn implement — wall-clock timeout (ms)',
    description: 'Optional hard timeout for an `implement` subagent. 0 = unlimited. Default 0.',
    type: 'int',
    category: 'agent',
    default: '0',
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
    description: 'Max tool CALLS for a `verify` subagent. 0 = unlimited. Default 0.',
    type: 'int', category: 'agent', default: '0', min: 0, advanced: true,
  },
  {
    key: 'CODER_SPAWN_VERIFY_TIMEOUT_MS',
    label: 'spawn verify — wall-clock timeout (ms)',
    description: 'Optional hard timeout for a `verify` subagent. 0 = unlimited. Default 0.',
    type: 'int', category: 'agent', default: '0', min: 0, advanced: true,
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
    description: 'Max tool CALLS for a `review` subagent. 0 = unlimited. Default 0.',
    type: 'int', category: 'agent', default: '0', min: 0, advanced: true,
  },
  {
    key: 'CODER_SPAWN_REVIEW_TIMEOUT_MS',
    label: 'spawn review — wall-clock timeout (ms)',
    description: 'Optional hard timeout for a `review` subagent. 0 = unlimited. Default 0.',
    type: 'int', category: 'agent', default: '0', min: 0, advanced: true,
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
      'Max tool CALLS for a `full` spawn_agent subagent. 0 = unlimited. Default 0.',
    type: 'int',
    category: 'agent',
    default: '0',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_SPAWN_FULL_TIMEOUT_MS',
    label: 'spawn full — wall-clock timeout (ms)',
    description: 'Optional hard timeout for a `full` subagent. 0 = unlimited. Default 0.',
    type: 'int',
    category: 'agent',
    default: '0',
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
