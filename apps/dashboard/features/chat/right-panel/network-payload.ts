import type { ChatNetworkPolicySnapshot, ChatNetworkSnapshot } from '@mcp/api-bus';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const rows = (value: unknown, valid: (row: Record<string, unknown>) => boolean): boolean => Array.isArray(value) && value.every(row => object(row) && valid(row));

/** Validate the fields rendered by these panels before traversing an HTTP body. */
export function isNetworkSnapshot(value: unknown): value is ChatNetworkSnapshot {
  if (!object(value) || !object(value.config)) return false;
  const config = value.config;
  const team = value.companyTeam;
  if (team !== undefined && !(object(team) && text(team.masterId) && rows(team.members, row =>
    ['id', 'title', 'role', 'state', 'provider', 'model'].every(key => text(row[key])) && (row.projectId === null || number(row.projectId))))) return false;
  return text(value.self) && (value.stopped === undefined || typeof value.stopped === 'boolean')
    && text(config.sessionId) && text(config.rootId) && (config.projectId === null || number(config.projectId))
    && typeof config.enabled === 'boolean' && Array.isArray(config.projectIds) && config.projectIds.every(number)
    && text(config.role) && number(config.maxSessions) && number(config.maxWakeups) && text(config.budgetId)
    && rows(value.peers, row => text(row.id) && text(row.sessionId) && text(row.label) && text(row.profile) && text(row.state))
    && rows(value.messages, row => ['id', 'from', 'to', 'kind', 'body', 'status'].every(key => text(row[key])) && strings(row.references))
    && rows(value.candidates, row => text(row.id) && text(row.title))
    && rows(value.links, row => strings(row.sessions) && row.sessions.length === 2 && typeof row.enabled === 'boolean')
    && rows(value.triggers, row => ['id', 'sourceSessionId', 'targetSessionId', 'status', 'event', 'prompt'].every(key => text(row[key])))
    && number(value.wakeCount) && number(value.rootBudget)
    && rows(value.chats, row => ['id', 'title', 'provider', 'model'].every(key => text(row[key])) && (row.projectId === null || number(row.projectId)))
    && (value.projects === undefined || rows(value.projects, row => number(row.id) && text(row.name)));
}

export function isNetworkPolicySnapshot(value: unknown): value is ChatNetworkPolicySnapshot {
  if (!object(value) || !object(value.settings) || !object(value.budget) || !object(value.budget.limits)) return false;
  const { settings, budget, policy } = value;
  if (!number(value.revision) || !['maxParallel', 'maxStarts'].every(key => settings[key] === undefined || number(settings[key]))
    || !['starts', 'active', 'tokens', 'uncertain'].every(key => number(budget[key]))
    || !number(value.budget.limits.maxStarts) || (budget.costUsd !== null && !number(budget.costUsd))) return false;
  return policy === null || (object(policy) && object(policy.effective) && object(policy.effective.reasoning)
    && (policy.presetVersion === undefined || text(policy.presetVersion))
    && object(policy.effective.parallelism) && number(policy.effective.parallelism.maxAgents)
    && (policy.effective.reasoning.effort === undefined || text(policy.effective.reasoning.effort))
    && text(policy.effective.reasoning.effort ?? policy.effective.reasoning.mode)
    && rows(policy.reasons, reason => text(reason.code)
      && [reason.requested, reason.effective].every(item => item == null || text(item) || number(item) || typeof item === 'boolean')));
}
