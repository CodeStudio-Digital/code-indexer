import type { ChatNetworkPolicySnapshot, ChatNetworkSnapshot } from '@mcp/api-bus';

export function collaborationData(sessionId: string): ChatNetworkSnapshot {
  return { self: `chat:${sessionId}`, stopped: false, peers: [], messages: [], candidates: [], links: [], triggers: [],
    config: { sessionId, rootId: sessionId, projectId: 1, projectIds: [1], enabled: false, role: '', maxSessions: 8, maxWakeups: 50, budgetId: 'fixture' },
    wakeCount: 0, rootBudget: 50, chats: [{ id: sessionId, title: 'Coordenador', projectId: 1, provider: 'p1', model: 'm1' }], policy: null };
}

export function collaborationPolicy(): ChatNetworkPolicySnapshot {
  return { isBudgetRoot: true, policy: null, settings: {}, revision: 0,
    budget: { rootId: 'fixture', starts: 0, active: 0, tokens: 0, costUsd: null, uncertain: 0, limits: { maxParallel: 3, maxStarts: 24 } } };
}
