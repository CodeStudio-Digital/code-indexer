import type { SettingDef } from './types.js';

/**
 * Company / multi-agent: orchestrator lifecycle + the AgentSupervisor safety
 * net (stuck-agent detection + recovery). Supervisor/watchdog toggles boot
 * inside each company worker, so they apply to the NEXT company session — no
 * full backend restart, hence no `restartNeeded`.
 */
export const COMPANY_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_COMPANY_IDLE_TIMEOUT_MS',
    label: 'Company idle timeout (ms)',
    description: 'Time a company subordinate can sit idle before the orchestrator evicts it.',
    type: 'int',
    category: 'company',
    default: '600000',
    min: 60_000,
    advanced: true,
  },
  {
    key: 'CODER_COMPANY_MAX_SUBORDINATES',
    label: 'Max concurrent subordinates',
    description: 'How many subordinate workers the orchestrator may host at once.',
    type: 'int',
    category: 'company',
    default: '6',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_COMPANY_ORCHESTRATOR_TTL_MS',
    label: 'Orchestrator TTL (ms)',
    description: 'Idle TTL for the orchestrator host itself.',
    type: 'int',
    category: 'company',
    default: '1800000',
    min: 60_000,
    advanced: true,
  },
  {
    key: 'MCP_SUPERVISOR_ENABLED',
    label: 'Agent supervisor (auto-recover stuck agents)',
    description:
      'Detects stuck company agents and recovers them (resume / resurrect master / abort), with circuit breakers to bound retries. The single biggest guard against a frozen company session. Applies to sessions started after you toggle it; watch incidents in Admin → Supervisor.',
    type: 'bool',
    category: 'company',
    default: '0',
  },
  {
    key: 'MCP_COMPANY_INBOX_WATCHDOG_ENABLED',
    label: 'Inbox watchdog',
    description:
      'Scans the cross-agent inbox for messages stuck pending/unanswered and expires or re-delivers them, so a blocked send_to_agent / send_to_master never hangs forever. Applies to new sessions.',
    type: 'bool',
    category: 'company',
    default: '0',
    advanced: true,
  },
  {
    key: 'MCP_COMPANY_INBOX_WATCHDOG_INTERVAL_MS',
    label: 'Inbox watchdog scan period (ms)',
    description: 'How often the inbox watchdog scans for stuck messages. Only relevant when the inbox watchdog is enabled. Default 30000 (30s).',
    type: 'int',
    category: 'company',
    default: '30000',
    min: 5_000,
    advanced: true,
  },
  {
    key: 'MCP_COMPANY_INBOX_WATCHDOG_STUCK_MS',
    label: 'Inbox watchdog stuck threshold (ms)',
    description: 'Pending/unanswered age after which the inbox watchdog expires or re-delivers a message. Default 300000 (5 min).',
    type: 'int',
    category: 'company',
    default: '300000',
    min: 30_000,
    advanced: true,
  },
  {
    key: 'MCP_COMPANY_INBOX_MAX_PENDING',
    label: 'Inbox max pending per target',
    description: 'A target agent is flagged "overloaded" (routing avoids it) once its pending+delivered inbox messages reach this. Default 3.',
    type: 'int',
    category: 'company',
    default: '3',
    min: 1,
    advanced: true,
  },
  {
    key: 'MCP_COMPANY_INBOX_STALE_IDLE_MS',
    label: 'Inbox stale-idle threshold (ms)',
    description: 'A waiting/paused target whose last activity is older than this counts as "stale_idle" in the inbox health check. Default 300000 (5 min).',
    type: 'int',
    category: 'company',
    default: '300000',
    min: 10_000,
    advanced: true,
  },
  {
    key: 'MCP_COMPANY_INBOX_HEALTH_CHECK',
    label: 'Inbox health gate (global)',
    description: 'When on, send_to_agent fails fast if the target is unhealthy (overloaded / failed / stale) instead of queueing. Off keeps the legacy queue-and-wait behavior. Default 0.',
    type: 'bool',
    category: 'company',
    default: '0',
    advanced: true,
  },
  {
    key: 'MCP_COMPANY_INBOX_WAIT_TIMEOUT_MS',
    label: 'Inbox wait timeout (ms)',
    description: 'How long a queued inbox message waits for delivery before it is marked EXPIRED. Default 1200000 (20 min).',
    type: 'int',
    category: 'company',
    default: '1200000',
    min: 60_000,
    advanced: true,
  },
  {
    key: 'MCP_COMPANY_RECONCILE_MS',
    label: 'Runtime reconciler cadence (ms)',
    description: 'How often the company RuntimeReconciler reconciles in-memory runtime state with the DB. Default 45000 (45s).',
    type: 'int',
    category: 'company',
    default: '45000',
    min: 5_000,
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
