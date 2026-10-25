import type { AgentPreset } from '@mcp/api-bus';
import type { CoderSession, SessionData, SessionId } from './types.js';

const BUILT_IN_AGENTS = new Set<AgentPreset>([
  'explore',
  'research',
  'plan',
  'build',
  'admin',
  'spec',
  'app_db',
  'api',
  'diagram',
  'builder',
]);

export const DEFAULT_SESSION_AGENT: AgentPreset = 'explore';

export function isAgentPreset(value: unknown): value is AgentPreset {
  return typeof value === 'string'
    && (
      BUILT_IN_AGENTS.has(value as AgentPreset)
      || /^custom:[a-zA-Z0-9-]{8,80}$/.test(value)
    );
}

/** Resolve only the selected session, never a stale useApi payload. */
export function hydratedSessionAgent(
  session: CoderSession | null | undefined,
  selectedId: SessionId | null,
): AgentPreset | null {
  if (!session || selectedId == null || session.id !== selectedId) return null;
  return isAgentPreset(session.agent) ? session.agent : DEFAULT_SESSION_AGENT;
}

/** Apply optimistic/server state only to the matching conversation cache. */
export function mergeSessionAgentData(
  data: SessionData,
  sessionId: SessionId,
  agent: AgentPreset,
  response?: CoderSession | null,
): SessionData {
  if (data.session.id !== sessionId) return data;
  return {
    ...data,
    session: {
      ...data.session,
      ...(response?.id === sessionId ? response : {}),
      agent,
    },
  };
}
