/** Product-level execution profiles exposed by the asynchronous MCP agent API. */
export const MCP_AGENT_EXECUTION_MODES = ['standard', 'ultra'] as const;

export type McpAgentExecutionMode = (typeof MCP_AGENT_EXECUTION_MODES)[number];

export interface StartMcpAgentRunInput {
  projectName: string;
  task: string;
  agentId: string;
  provider: string;
  model: string;
  title?: string;
  /** Provider-independent host orchestration profile. Defaults to standard. */
  executionMode?: McpAgentExecutionMode;
  /** Native provider effort only. The legacy literal `ultra` is normalized below. */
  reasoningEffort?: string;
}

interface McpAgentSessionCreatePayload {
  project_id: number;
  title: string;
  provider: string;
  model: string;
  agent: string;
  execution_mode: McpAgentExecutionMode;
  reasoning_effort?: string;
  metadata?: {
    mcp_agent_run: {
      schema_version: 1;
      principal: string;
      profile_id: string | null;
      agent_id: string;
      task_preview: string;
    };
  };
}

/**
 * Parse the public MCP argument even when a caller bypasses JSON-schema
 * validation (for example, a direct unit/in-process invocation).
 */
export function parseMcpAgentExecutionMode(value: unknown): McpAgentExecutionMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'standard' || value === 'ultra') return value;
  throw new Error(`execution_mode must be one of: ${MCP_AGENT_EXECUTION_MODES.join(', ')}`);
}

/**
 * Build the normal-session HTTP contract consumed by /api/coder/sessions.
 *
 * Older MCP clients used `reasoning_effort: "ultra"`. Ultra is a host
 * execution profile, not a provider reasoning value, so convert that sentinel
 * to execution_mode and remove it from the provider-native effort field before
 * the request crosses the MCP boundary.
 */
export function buildMcpAgentSessionCreatePayload(
  input: StartMcpAgentRunInput,
  projectId: number,
  runMetadata?: {
    principal: string;
    profileId: string | null;
  },
): McpAgentSessionCreatePayload {
  const normalizedEffort = input.reasoningEffort?.trim() || undefined;
  const legacyUltra = normalizedEffort?.toLowerCase() === 'ultra';

  return {
    project_id: projectId,
    title: (input.title?.trim() || `MCP: ${input.task.slice(0, 80)}`).slice(0, 160),
    provider: input.provider,
    model: input.model,
    agent: input.agentId,
    execution_mode: input.executionMode ?? (legacyUltra ? 'ultra' : 'standard'),
    ...(!legacyUltra && normalizedEffort ? { reasoning_effort: normalizedEffort } : {}),
    ...(runMetadata
      ? {
          metadata: {
            mcp_agent_run: {
              schema_version: 1 as const,
              principal: runMetadata.principal,
              profile_id: runMetadata.profileId,
              agent_id: input.agentId,
              task_preview: input.task.slice(0, 500),
            },
          },
        }
      : {}),
  };
}
