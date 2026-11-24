import type { MasterPromptDeliveryStatus } from './company-session-file-types.js';
import { assertUuid, asAgentRunId, type SessionMetadata } from '@mcp/session-storage';
import type { AgentRunStatus, BoardKind, CompanyAgentDispatchSource, InboxKind, InboxPriority, InboxStatus, KanbanCardAgent, KanbanCardDependency, KanbanChecklistItem, KanbanColumn, KanbanComment, KanbanTag } from '@mcp/company/types.js';
export function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function dispatchSource(value: unknown): CompanyAgentDispatchSource {
  return value === 'scheduler' ||
    value === 'manual' ||
    value === 'fanout' ||
    value === 'app_studio' ||
    value === 'retry'
    ? value
    : 'company';
}

export function runStatus(value: unknown): AgentRunStatus {
  return value === 'idle' ||
    value === 'running' ||
    value === 'working' ||
    value === 'waiting' ||
    value === 'waiting_plan' ||
    value === 'waiting_question' ||
    value === 'waiting_tasks' ||
    value === 'reviewing' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'interrupted' ||
    value === 'paused' ||
    value === 'error' ||
    value === 'aborted'
    ? value
    : 'idle';
}

export function nonNegativeSafeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

export function boardKind(value: unknown): BoardKind {
  if (
    value === 'message' ||
    value === 'decision' ||
    value === 'question' ||
    value === 'deliverable' ||
    value === 'handoff' ||
    value === 'blocker'
  ) {
    return value;
  }
  throw new Error(`Invalid Company board kind ${String(value)}`);
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Invalid Company board mentions');
  }
  return [...value];
}

export const ACTIVE_SUBORDINATE_STATUSES = new Set<AgentRunStatus>([
  'running',
  'working',
  'waiting',
  'waiting_plan',
  'waiting_question',
  'waiting_tasks',
  'reviewing',
  'blocked',
]);

export function companyMetadata(session: SessionMetadata): Record<string, unknown> {
  return object(session.metadata.company);
}

export function inboxKind(value: unknown): InboxKind {
  if (value === 'question' || value === 'notify') return value;
  throw new Error(`Invalid Company inbox kind ${String(value)}`);
}

export function inboxStatus(value: unknown): InboxStatus {
  if (
    value === 'pending' ||
    value === 'delivered' ||
    value === 'answered' ||
    value === 'cancelled' ||
    value === 'expired'
  ) {
    return value;
  }
  throw new Error(`Invalid Company inbox status ${String(value)}`);
}

export function inboxPriority(value: unknown): InboxPriority {
  if (value === 'low' || value === 'urgent') return value;
  if (value === 'normal' || value == null) return 'normal';
  throw new Error(`Invalid Company inbox priority ${String(value)}`);
}

export function nullableUuid(value: unknown, label: string): string | null {
  const raw = nullableString(value);
  return raw == null ? null : assertUuid(raw, label);
}

export function inboxRelations(
  data: Record<string, unknown>,
): Record<string, string> {
  const fromAgentRunId = asAgentRunId(
    stringValue(data.from_agent_run_id),
  );
  const toAgentRunId = nullableString(data.to_agent_run_id);
  const threadId = nullableString(data.thread_id);
  const replyToMessageId = nullableString(data.reply_to_message_id);
  return {
    from_agent_run_id: fromAgentRunId,
    ...(toAgentRunId
      ? { to_agent_run_id: asAgentRunId(toAgentRunId) }
      : {}),
    ...(threadId
      ? { thread_id: assertUuid(threadId, 'Company inbox thread id') }
      : {}),
    ...(replyToMessageId
      ? {
          reply_to_message_id: assertUuid(
            replyToMessageId,
            'Company inbox reply message id',
          ),
        }
      : {}),
  };
}

export function kanbanColumn(value: unknown): KanbanColumn {
  if (
    value === 'backlog' ||
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'review' ||
    value === 'done'
  ) {
    return value;
  }
  throw new Error(`Invalid Company kanban column ${String(value)}`);
}

export function kanbanTag(value: unknown): KanbanTag | null {
  if (value == null) return null;
  if (
    value === 'bug' ||
    value === 'feature' ||
    value === 'refactor' ||
    value === 'documentation'
  ) {
    return value;
  }
  throw new Error(`Invalid Company kanban tag ${String(value)}`);
}

export function kanbanChecklist(
  cardId: string,
  value: unknown,
): KanbanChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = object(item);
    return {
      id: assertUuid(stringValue(row.id), 'Company checklist item id'),
      card_id: cardId,
      text: stringValue(row.text),
      checked: row.checked === true,
      position: nonNegativeSafeInteger(row.position, index),
    };
  });
}

export function kanbanComments(
  cardId: string,
  value: unknown,
): KanbanComment[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = object(item);
    const rawAgentRunId = nullableString(row.agent_run_id);
    return {
      id: assertUuid(stringValue(row.id), 'Company kanban comment id'),
      card_id: cardId,
      author_role: stringValue(row.author_role),
      agent_run_id:
        rawAgentRunId == null ? null : asAgentRunId(rawAgentRunId),
      content: stringValue(row.content),
      created_at: stringValue(row.created_at),
    };
  });
}

export function kanbanAgents(
  cardId: string,
  value: unknown,
): KanbanCardAgent[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = object(item);
    return {
      id: assertUuid(stringValue(row.id), 'Company kanban assignment id'),
      card_id: cardId,
      agent_run_id: asAgentRunId(stringValue(row.agent_run_id)),
      role: stringValue(row.role),
      assigned_at: stringValue(row.assigned_at),
      ...(typeof row.session_id === 'string' && { session_id:row.session_id }),
      unassigned_at: nullableString(row.unassigned_at),
    };
  });
}

export function kanbanDependencies(
  cardId: string,
  value: unknown,
): KanbanCardDependency[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = object(item);
    return {
      id: assertUuid(stringValue(row.id), 'Company kanban dependency id'),
      card_id: cardId,
      depends_on_id: assertUuid(
        stringValue(row.depends_on_id),
        'Company kanban dependency target id',
      ),
      created_at: stringValue(row.created_at),
    };
  });
}

export function promptDeliveryStatus(value: unknown): MasterPromptDeliveryStatus {
  return value === 'delivering' ||
    value === 'delivered' ||
    value === 'outcome_unknown'
    ? value
    : 'pending';
}
