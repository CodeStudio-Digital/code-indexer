export const AGENT_READ_NAMES = ['list_agents', 'list_agent_runs', 'get_agent_run', 'get_agent_result'] as const;
export type AgentReadName = typeof AGENT_READ_NAMES[number];
/** Read-only, current-application query. The Host supplies project authority;
 * input cannot select an HTTP endpoint, database, principal or project. */
export interface AgentReadPort {
  read(name: AgentReadName, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
