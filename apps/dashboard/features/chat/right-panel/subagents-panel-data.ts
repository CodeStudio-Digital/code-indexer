import type { AgentsGroup, AssistantTurn } from '../../../hooks/agent-stream/types.js';
import type { SessionData } from '../types.js';
import { parsePersistedAgentsGroup } from '../messages/agents-group-parser.js';

export interface ListedAgentsGroup {
  key: string;
  group: AgentsGroup;
  source: 'live' | 'history';
  active: boolean;
}

interface PersistedResult {
  content: string;
  isError: boolean;
}

export function collectListedGroups(
  sessionData: SessionData | null,
  currentTurn: AssistantTurn | null,
): { activeGroups: ListedAgentsGroup[]; recentGroups: ListedAgentsGroup[] } {
  const liveGroups: ListedAgentsGroup[] = (currentTurn?.blocks ?? [])
    .flatMap((block) => (
      block.type === 'agents' && !block.group.groupId.startsWith('tasks-wave-')
        ? [block.group]
        : []
    ))
    .reverse()
    .map((group) => ({
      key: `live:${group.groupId}`,
      group,
      source: 'live' as const,
      active: group.status === 'running',
    }));

  const sessionRunning = sessionData?.session.status === 'running';
  // Match each live group to at most one persisted group. Canonical tool/group
  // identity wins; the label/task fingerprint is only a compatibility fallback
  // for legacy stream events that predate toolUseId propagation.
  const unmatchedLive = [...liveGroups];
  const persistedGroups = collectPersistedGroups(sessionData).filter((entry) => {
    const matchIndex = unmatchedLive.findIndex((live) => groupsMatch(live.group, entry.group));
    if (matchIndex < 0) return true;
    unmatchedLive.splice(matchIndex, 1);
    return false;
  }).map((entry) => ({
    ...entry,
    active: sessionRunning && entry.group.status === 'running',
  }));

  return {
    activeGroups: [
      ...liveGroups.filter((entry) => entry.active),
      ...persistedGroups.filter((entry) => entry.active),
    ],
    recentGroups: [
      ...liveGroups.filter((entry) => !entry.active),
      ...persistedGroups.filter((entry) => !entry.active),
    ].slice(0, 40),
  };
}

function collectPersistedGroups(sessionData: SessionData | null): ListedAgentsGroup[] {
  if (!sessionData) return [];

  const results = new Map<string, PersistedResult>();
  for (const fallback of sessionData.tool_results ?? []) {
    results.set(fallback.tool_use_id, {
      content: fallback.content,
      isError: fallback.is_error,
    });
  }
  for (const message of sessionData.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      results.set(block.tool_use_id, {
        content: block.content ?? '',
        isError: Boolean(block.is_error),
      });
    }
  }

  const groups: ListedAgentsGroup[] = [];
  sessionData.messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (
        block.type !== 'tool_use'
        || (block.name !== 'spawn_agent' && block.name !== 'spawn_agents')
      ) return;

      const result = block.id ? results.get(block.id) : undefined;
      const parsed = parsePersistedAgentsGroup(block.input, result, block.id);
      if (!parsed) return;
      const stableId = block.id ?? `${messageIndex}-${blockIndex}`;
      groups.push({
        key: `history:${stableId}`,
        group: parsed,
        source: 'history',
        active: false,
      });
    });
  });

  return groups.reverse();
}

function groupFingerprint(group: AgentsGroup): string {
  return group.agents
    .map((agent) => `${agent.label.trim()}\u0000${agent.task?.trim() ?? ''}`)
    .join('\u0001');
}

function groupsMatch(live: AgentsGroup, persisted: AgentsGroup): boolean {
  if (live.toolUseId && live.toolUseId === persisted.toolUseId) return true;
  if (live.groupId === persisted.groupId) return true;
  if (live.toolUseId && persisted.toolUseId) return false;
  return groupFingerprint(live) === groupFingerprint(persisted);
}
