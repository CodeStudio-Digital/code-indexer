import type { SettingDef } from './types.js';

/**
 * Company / multi-agent: orchestrator lifecycle + the cross-agent inbox. The
 * AgentSupervisor + stall-watchdog knobs live in `company-supervisor.ts` (split
 * to keep both under the LOC cap). Toggles boot inside each company worker, so
 * they apply to the NEXT company session — no full backend restart, hence no
 * `restartNeeded`.
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
    key: 'MCP_COMPANY_MASTER_NUDGE_MS',
    label: 'Master re-nudge threshold (ms)',
    description:
      'When a subordinate has been blocked waiting on the master (plan/question/tasks, ' +
      'or a master-bound inbox message) longer than this, the RuntimeReconciler re-wakes ' +
      'the master WITHOUT calling the LLM — re-emitting the attention signal or re-running ' +
      'inbox delivery. Bridges the gap to the 30-min MCP_SUBORDINATE_MASTER_WAIT_MS hard ' +
      'fallback so a single lost wake-up no longer strands a subordinate. 0 disables. ' +
      'Default 30000 (30s).',
    type: 'int',
    category: 'company',
    default: '30000',
    min: 0,
    advanced: true,
  },
];
