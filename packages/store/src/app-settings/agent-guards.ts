import type { SettingDef } from './types.js';

/** Retry settings that project into the attempt-scoped RuntimePolicy. */
export const AGENT_GUARD_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_RECOVERY_TRANSIENT_MAX',
    label: 'Recovery cap — transient retries',
    description: 'Max transient retries across one attempt. Default 30.',
    type: 'int',
    category: 'agent',
    default: '30',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_TRANSIENT_RETRY_MAX_PER_TURN',
    label: 'Transient retries per provider call',
    description: 'Single retry authority for one logical provider call. Default 3.',
    type: 'int',
    category: 'agent',
    default: '3',
    min: 0,
    advanced: true,
  },
];
