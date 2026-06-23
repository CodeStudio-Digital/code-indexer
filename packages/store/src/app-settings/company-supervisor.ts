import type { SettingDef } from './types.js';

/**
 * Company supervisor & stall watchdogs — the AgentSupervisor anti-hang net
 * (stuck-agent detection + recovery) plus the idle stall watchdog and the
 * subordinate→master wait fallback. Split out of `company.ts` to keep both
 * modules under the LOC cap (the supervisor cluster grows with recovery knobs).
 * These boot inside each company worker, so they apply to the NEXT company
 * session — no full backend restart, hence no `restartNeeded`.
 */
export const COMPANY_SUPERVISOR_SETTINGS: readonly SettingDef[] = [
  {
    key: 'MCP_SUPERVISOR_ENABLED',
    label: 'Agent supervisor (auto-recover stuck agents)',
    description:
      'Detects stuck company agents and recovers them (resume / resurrect master / unwedge tool), with circuit breakers to bound retries. The single biggest guard against a frozen company session. On by default; set to 0 to disarm. Applies to sessions started after you toggle it; watch incidents in Admin → Supervisor.',
    type: 'bool',
    category: 'company',
    default: '1',
  },
  {
    key: 'MCP_SUPERVISOR_RECOVERY_MODE',
    label: 'Supervisor recovery mode',
    description:
      'How the supervisor reacts to a stuck tool call. "inject" (default) unwedges the single call with a synthetic error so the run continues; "abort" terminates the whole runner instead; "read_only" detects + logs incidents but never acts; "off" disables recovery (detection only). Only relevant when the supervisor is enabled.',
    type: 'string',
    category: 'company',
    default: 'inject',
    options: ['inject', 'abort', 'read_only', 'off'],
    advanced: true,
  },
  {
    key: 'MCP_SUPERVISOR_PERSISTENCE',
    label: 'Supervisor persistence (ghost cleanup on boot)',
    description:
      'Persists supervisor state to agent_supervision so a restart can detect agents whose process died mid-run and mark them terminal. Set 0 to keep the supervisor in-memory only. Only relevant when the supervisor is enabled.',
    type: 'bool',
    category: 'company',
    default: '1',
    advanced: true,
  },
  {
    key: 'MCP_AGENT_WATCHDOG_MS',
    label: 'Stall threshold (ms)',
    description:
      'How long a company session may go with no activity (master idle, no subordinate running) before the dashboard shows a "stalled" banner with a manual nudge. Default 300000 (5 min).',
    type: 'int',
    category: 'company',
    default: '300000',
    min: 30_000,
    advanced: true,
  },
  {
    key: 'MCP_AGENT_WATCHDOG_TICK_MS',
    label: 'Stall check interval (ms)',
    description: 'How often the idle watchdog polls for a stalled session. Default 60000 (60s).',
    type: 'int',
    category: 'company',
    default: '60000',
    min: 10_000,
    advanced: true,
  },
  {
    key: 'MCP_SUBORDINATE_MASTER_WAIT_MS',
    label: 'Subordinate → Master wait timeout (ms)',
    description:
      'Safety deadline for a subordinate blocked on ask_master / submit_plan_to_master / ' +
      'submit_tasks_to_master. If the Master never answers (crashed/ended with the supervisor ' +
      'off) the subordinate is unblocked with an error so it proceeds on its own instead of ' +
      'hanging forever. Long by design — never fires in a healthy session. Default 1800000 (30 min).',
    type: 'int',
    category: 'company',
    default: '1800000',
    min: 60_000,
    advanced: true,
  },
];
