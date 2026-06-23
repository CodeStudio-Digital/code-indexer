/**
 * Response read cap (memory bound) for the API client, shared by the send route,
 * the regression runner and the agent run tools so a manual send and a CI/agent
 * replay buffer the SAME number of bytes. Without this the runner/agent fell back
 * to the engine's 512KB default while a manual send used 5MB — a 512KB–5MB JSON
 * body was returned whole by a send but truncated in replay, failing JSON.parse
 * as a false "body is not JSON". Floor 64KB; override via MCP_API_CLIENT_READ_CAP.
 */
export function apiClientReadCap(): number {
  return Math.max(64 * 1024, Number(process.env.MCP_API_CLIENT_READ_CAP) || 5 * 1024 * 1024);
}
