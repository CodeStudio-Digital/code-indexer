import type { SettingDef } from './types.js';

/** Attempt-scoped output policy exposed to operators. */
export const AGENT_OUTPUT_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_PUSH_TIME_CAP',
    label: 'Default tool-result target (chars)',
    description: 'Default inline target for generic tool results in the resolved RuntimePolicy.',
    type: 'int',
    category: 'agent',
    default: '24000',
    min: 1024,
    advanced: true,
  },
];
