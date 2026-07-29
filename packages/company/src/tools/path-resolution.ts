/**
 * Shared path-resolution helpers for master tools.
 *
 * The unified agent tree introduced `path`-addressed tools (`list_agents`,
 * `wait_agents`, `send_message`, `send_input`). For the existing master
 * tools that still require `agent_run_id`, this helper parses an optional
 * `path` argument so the master can use either form interchangeably.
 *
 * Path format: `/root/master/<role>-<agentRunId>`. The role segment is
 * informational — only the trailing UUID is consumed. The match is
 * deliberately loose on the role to tolerate roles with hyphens (e.g.
 * `qa-frontend`); it anchors on the canonical UUID at the end.
 */
import {
  asAgentRunId,
  type AgentRunId,
} from '@mcp/session-storage';

export type ResolvedAgentTarget =
  | { ok: true; agentRunId: AgentRunId }
  | { ok: false; detail: string };

/**
 * Resolve `agent_run_id` from the tool args, accepting either the explicit
 * UUID or a `path` like `/root/master/<role>-<uuid>`. Returns a structured
 * result so callers can include the failure reason in the tool result.
 */
export function resolveAgentRunId(args: Record<string, unknown>): ResolvedAgentTarget {
  const explicit = args.agent_run_id;
  if (typeof explicit === 'string') {
    try {
      return { ok: true, agentRunId: asAgentRunId(explicit) };
    } catch {
      // Fall through to the path form or the structured validation error.
    }
  }
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) {
    return {
      ok: false,
      detail: 'pass either `agent_run_id` (UUID) or `path` (e.g. "/root/master/qa-<uuid>"). Use list_agents to discover paths.',
    };
  }
  const parsed = parseAgentPath(path);
  if (parsed === null) {
    return {
      ok: false,
      detail: `'${path}' is not a recognized agent path. Expected /root/master/<role>-<agentRunId>.`,
    };
  }
  return { ok: true, agentRunId: parsed };
}

/**
 * Parse an agent path into its trailing agent_run_id, or null when the
 * shape is wrong. Returns null for `/root` and `/root/master` because
 * those don't carry a numeric id — callers that want to address those
 * targets should use `parseAgentPathTarget` instead.
 */
export function parseAgentPath(path: string): AgentRunId | null {
  const t = parseAgentPathTarget(path);
  return t && t.kind === 'subordinate' ? t.agentRunId : null;
}

/**
 * Richer parse for tools that distinguish master from subordinate targets
 * (`send_message`, `send_input`). Returns:
 *   - `{ kind: 'master' }` for `/root/master`
 *   - `{ kind: 'subordinate', agentRunId }` for `/root/master/<role>-<id>`
 *   - `null` for anything else (including `/root`).
 */
export type AgentPathTarget =
  | { kind: 'master'; agentRunId: null }
  | { kind: 'subordinate'; agentRunId: AgentRunId };

export function parseAgentPathTarget(path: string): AgentPathTarget | null {
  if (path === '/root') return null;
  if (path === '/root/master') return { kind: 'master', agentRunId: null };
  const m = path.match(
    /^\/root\/master\/.+-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (!m) return null;
  return {
    kind: 'subordinate',
    agentRunId: asAgentRunId(m[1]),
  };
}
