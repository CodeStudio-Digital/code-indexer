import { defineTool, mcpAccess, type McpTool, type McpToolOutput } from '../tool.js';
import { getMcpAgentRunManager } from '../agent-run-manager.js';
import {
  MCP_AGENT_EXECUTION_MODES,
  parseMcpAgentExecutionMode,
} from '../agent-run-contract.js';

function output(value: unknown, text?: string): McpToolOutput {
  const structuredContent = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : { value };
  return { text: text ?? JSON.stringify(value, null, 2), structuredContent };
}

const list_agents = defineTool({
  name: 'list_agents',
  tier: 'bootstrap',
  ...mcpAccess('read'),
  description:
    'List CodeStudio built-in/custom agents and configured provider/model choices available for start_agent_run.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => output(await getMcpAgentRunManager(ctx).catalog()),
});

const start_agent_run = defineTool({
  name: 'start_agent_run',
  tier: 'navigate',
  ...mcpAccess('write'),
  description:
    'Start a CodeStudio agent asynchronously and return a persistent run_id immediately. ' +
    'Use get_agent_run/get_agent_result to poll it. execution_mode selects the provider-independent host orchestration profile; ' +
    'reasoning_effort remains a native provider control. Connection profiles restrict projects, agents, concurrency and runtime.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      task: { type: 'string' },
      agent_id: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      title: { type: 'string' },
      execution_mode: {
        type: 'string',
        enum: MCP_AGENT_EXECUTION_MODES,
        default: 'standard',
        description: 'Host execution profile. Ultra never becomes a provider reasoning-effort value.',
      },
      reasoning_effort: {
        type: 'string',
        description: 'Optional native provider reasoning effort. Legacy value "ultra" is accepted and converted to execution_mode=ultra.',
      },
    },
    required: ['project_name', 'task', 'agent_id', 'provider', 'model'],
  },
  handler: async (args, ctx, authCtx) => {
    const run = await getMcpAgentRunManager(ctx).start({
      projectName: String(args.project_name ?? ''),
      task: String(args.task ?? ''),
      agentId: String(args.agent_id ?? ''),
      provider: String(args.provider ?? ''),
      model: String(args.model ?? ''),
      title: typeof args.title === 'string' ? args.title : undefined,
      executionMode: parseMcpAgentExecutionMode(args.execution_mode),
      reasoningEffort: typeof args.reasoning_effort === 'string' ? args.reasoning_effort : undefined,
    }, authCtx);
    return output(run, `Agent run ${run.id} started (CodeStudio session ${run.sessionId}).`);
  },
});

const list_agent_runs = defineTool({
  name: 'list_agent_runs',
  tier: 'bootstrap',
  ...mcpAccess('read'),
  description: 'List recent asynchronous agent runs owned by the current MCP principal.',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number' } },
  },
  handler: async (args, ctx, authCtx) => {
    const runs = await getMcpAgentRunManager(ctx).list(authCtx, Number(args.limit ?? 50));
    return output({ runs });
  },
});

const get_agent_run = defineTool({
  name: 'get_agent_run',
  tier: 'bootstrap',
  ...mcpAccess('read'),
  description: 'Read status and metadata for an asynchronous CodeStudio agent run.',
  inputSchema: {
    type: 'object',
    properties: { run_id: { type: 'string' } },
    required: ['run_id'],
  },
  handler: async (args, ctx, authCtx) => output(
    await getMcpAgentRunManager(ctx).get(String(args.run_id ?? ''), authCtx),
  ),
});

const get_agent_result = defineTool({
  name: 'get_agent_result',
  tier: 'bootstrap',
  ...mcpAccess('read'),
  description: 'Return the terminal answer for a completed agent run, or its current status while still running.',
  inputSchema: {
    type: 'object',
    properties: { run_id: { type: 'string' } },
    required: ['run_id'],
  },
  handler: async (args, ctx, authCtx) => {
    const run = await getMcpAgentRunManager(ctx).get(String(args.run_id ?? ''), authCtx);
    return output({
      run_id: run.id,
      status: run.status,
      session_id: run.sessionId,
      result: run.finalText,
      error: run.error,
    }, run.finalText ?? `Agent run ${run.id} is ${run.status}.`);
  },
});

const cancel_agent_run = defineTool({
  name: 'cancel_agent_run',
  tier: 'navigate',
  ...mcpAccess('write'),
  description: 'Cancel an active asynchronous CodeStudio agent run owned by the current MCP principal.',
  inputSchema: {
    type: 'object',
    properties: { run_id: { type: 'string' } },
    required: ['run_id'],
  },
  handler: async (args, ctx, authCtx) => output(
    await getMcpAgentRunManager(ctx).cancel(String(args.run_id ?? ''), authCtx),
  ),
});

export const agentTools: McpTool[] = [
  list_agents,
  start_agent_run,
  list_agent_runs,
  get_agent_run,
  get_agent_result,
  cancel_agent_run,
];
