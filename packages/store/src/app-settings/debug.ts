import type { SettingDef } from './types.js';

/** Debug & logging. */
export const DEBUG_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_LOG_TOOLS_COUNT',
    label: 'Log tool count per turn',
    description: 'Emits `[coder] N tools registered` on every turn so you can verify tier promotion.',
    type: 'bool',
    category: 'debug',
    default: '0',
  },
  {
    key: 'CODER_DISABLED_MCP_TOOLS',
    label: 'Disabled MCP tools',
    description: 'Comma-separated `mcp__*` tool names to hide from the registry. Useful to A/B a tool.',
    type: 'string',
    category: 'debug',
    advanced: true,
  },
  {
    key: 'CODER_MODEL_CAPS',
    label: 'Model capability overrides',
    description: 'JSON map of model id → capability flags. Advanced; see docs.',
    type: 'string',
    category: 'debug',
    advanced: true,
  },
];
