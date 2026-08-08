import type { SettingDef } from './types.js';

/** Debug & logging. */
export const DEBUG_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_DISABLED_MCP_TOOLS',
    label: 'Disabled MCP tools',
    description: 'Comma-separated `mcp__*` tool names to hide from the registry. Useful to A/B a tool.',
    type: 'string',
    category: 'debug',
    advanced: true,
  },
];
