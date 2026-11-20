import type { SettingDef } from './types.js';

/** MCP transport + worker lifecycle. */
export const MCP_SETTINGS: readonly SettingDef[] = [
  {
    key: 'MCP_DEV_HTTP',
    label: 'Expose HTTP listener for development',
    description:
      'Binds the in-process API to 127.0.0.1:7333 so you can hit endpoints from curl / a second tool. Off by default; the IDE uses mcp:// in-process dispatch instead.',
    type: 'bool',
    category: 'mcp',
    default: '0',
    restartNeeded: true,
  },
  {
    key: 'CODER_WORKER_HEAP_MB',
    label: 'Coder worker heap (MB)',
    description:
      'Per-session V8 old-generation limit. Default 1024 MB. Raise only for unusually large histories or tool catalogs.',
    type: 'int',
    category: 'mcp',
    default: '1024',
    min: 256,
    restartNeeded: true,
    advanced: true,
  },
  {
    key: 'MCP_CODER_WORKER_DEBUG',
    label: 'Verbose worker logs',
    description: 'Dumps RPC + bus event breadcrumbs on coder-worker crashes.',
    type: 'bool',
    category: 'mcp',
    default: '0',
    advanced: true,
  },
  {
    key: 'MCP_CODER_WORKER_STRICT_CRASH',
    label: 'Strict worker crash policy',
    description:
      'Kills the worker on EVERY uncaught error (vs the default "keep alive on transient network errors"). Use when chasing a recurring bug.',
    type: 'bool',
    category: 'mcp',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_WORKER_TTL_MS',
    label: 'Worker idle TTL (ms)',
    description: 'How long an idle coder worker stays alive before eviction. Default 5 minutes.',
    type: 'int',
    category: 'mcp',
    default: '300000',
    min: 30_000,
    advanced: true,
  },
  {
    key: 'MCP_HTTP_REQUEST_TIMEOUT_MS',
    label: 'HTTP request timeout (ms)',
    description:
      "Wall-clock cap on HTTP requests, including the SSE streams that drive long `spawn_agents` runs. " +
      "Node's default (300000ms = 5 min) was killing subagent explorations on big codebases. " +
      'Default 3600000 (60 min). Lower to kill runaway runs faster; raise for 10k+ file projects. Restart required.',
    type: 'int',
    category: 'mcp',
    default: '3600000',
    min: 60_000,
    advanced: true,
    restartNeeded: true,
  },
  {
    key: 'CODER_WORKER_POST_RUN_LINGER_MS',
    label: 'Worker post-run linger (ms)',
    description: 'Window the worker waits for a follow-up message before evicting. Default 30s.',
    type: 'int',
    category: 'mcp',
    default: '30000',
    min: 0,
    advanced: true,
  },
];
