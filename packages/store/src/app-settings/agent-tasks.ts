import type { SettingDef } from './types.js';

/**
 * Agent — execute_tasks per-kind limits (PR-A..F).
 *
 * Per-kind caps applied by `execute_tasks` when it dispatches each subagent
 * (investigate / implement / verify). `estimated_complexity` multiplies these
 * (small=0.5x, medium=1x, large=2x) BEFORE the runner enforces them — so
 * changing them here shifts the BASELINE for every complexity tier.
 *
 * No restart needed: `resolveTaskLimit()` reads process.env on every dispatch,
 * so saving in the panel takes effect on the next task.
 */
export const AGENT_TASK_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_TASK_INVESTIGATE_MAX_TOOLS',
    label: 'Investigate task — max tool calls',
    description:
      'Cap on tool invocations for an `investigate` subagent (read-only exploration). ' +
      'Multiplied by complexity (small 0.5x, large 2x) before enforcement. Default 40.',
    type: 'int',
    category: 'agent',
    default: '40',
    min: 1,
  },
  {
    key: 'CODER_TASK_INVESTIGATE_TIMEOUT_MS',
    label: 'Investigate task — wall-clock timeout (ms)',
    description: 'Maximum wall-clock duration for an `investigate` subagent. Default 600000 (10 min).',
    type: 'int',
    category: 'agent',
    default: '600000',
    min: 30_000,
  },
  {
    key: 'CODER_TASK_IMPLEMENT_MAX_TOOLS',
    label: 'Implement task — max tool calls',
    description:
      'Cap on tool invocations for an `implement` subagent (read + write + shell). ' +
      'Multiplied by complexity. Default 80.',
    type: 'int',
    category: 'agent',
    default: '80',
    min: 1,
  },
  {
    key: 'CODER_TASK_IMPLEMENT_TIMEOUT_MS',
    label: 'Implement task — wall-clock timeout (ms)',
    description: 'Maximum wall-clock duration for an `implement` subagent. Default 1200000 (20 min).',
    type: 'int',
    category: 'agent',
    default: '1200000',
    min: 30_000,
  },
  {
    key: 'CODER_TASK_VERIFY_MAX_TOOLS',
    label: 'Verify task — max tool calls',
    description:
      'Cap on tool invocations for a `verify` subagent (tests/linters/lsp, no write). ' +
      'Multiplied by complexity. Default 30.',
    type: 'int',
    category: 'agent',
    default: '30',
    min: 1,
  },
  {
    key: 'CODER_TASK_VERIFY_TIMEOUT_MS',
    label: 'Verify task — wall-clock timeout (ms)',
    description: 'Maximum wall-clock duration for a `verify` subagent. Default 900000 (15 min).',
    type: 'int',
    category: 'agent',
    default: '900000',
    min: 30_000,
  },
  {
    key: 'CODER_TASK_STALL_MS',
    label: 'Task subagent — stall threshold (ms)',
    description:
      'No-progress threshold. The watchdog aborts a task subagent that emits NO tool calls or ' +
      'heartbeats for this long. Applies to every kind. Default 120000 (2 min).',
    type: 'int',
    category: 'agent',
    default: '120000',
    min: 10_000,
  },
  {
    key: 'CODER_TASKS_DEFAULT_TOKEN_CAP',
    label: 'execute_tasks default token cap',
    description:
      'Total token budget across a single `execute_tasks` run. When the projected next-task ' +
      'spend would exceed this, the orchestrator asks the user to extend, stop after the current ' +
      'task, or cancel pending. 0 / empty = unlimited (no cap). Default 0.',
    type: 'int',
    category: 'agent',
    default: '0',
    min: 0,
  },
  {
    key: 'CODER_TASK_MAX_RETRIES',
    label: 'Task retry — max attempts',
    description:
      'Number of EXTRA attempts after the first failure (so 2 = up to 3 total attempts). ' +
      'Retries only fire on transient errors (timeout, 5xx, 429, watchdog) — fatal errors ' +
      '(auth, validation) bail immediately. Default 2.',
    type: 'int',
    category: 'agent',
    default: '2',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_TASK_RETRY_INITIAL_MS',
    label: 'Task retry — initial backoff (ms)',
    description: 'Wait before the first retry. Doubles each subsequent attempt (capped). Default 1000.',
    type: 'int',
    category: 'agent',
    default: '1000',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_TASK_RETRY_MAX_MS',
    label: 'Task retry — max backoff (ms)',
    description: 'Ceiling on the exponential backoff. Default 16000 (16s).',
    type: 'int',
    category: 'agent',
    default: '16000',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_TASKS_DISABLE_SKIP_STALE',
    label: 'Disable skip-stale check',
    description:
      'When on, `execute_tasks` always re-runs every task even if its file inputs (mtime/size + ' +
      'system prompt version) match a prior successful run. Use when side-effects outside the ' +
      'file scope might have changed (env, DB, external API).',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
];
