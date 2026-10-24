import { nullableString, stringValue, dispatchSource, runStatus, nonNegativeSafeInteger, boardKind, stringArray, inboxKind, inboxStatus, inboxPriority, nullableUuid, kanbanColumn, kanbanTag, kanbanChecklist, kanbanComments, kanbanAgents, kanbanDependencies } from './company-session-file-values.js';
import type { CompanyAgentRunFileRow } from './company-session-file-types.js';
import { assertUuid, asAgentRunId, asSessionId, type CompanySessionId, type EntityRecord } from '@mcp/session-storage';
import { lstatSync, readFileSync } from 'node:fs';
import type { AgentInboxMessage, BoardEntry, KanbanCardFull, MasterPrompt } from '@mcp/company/types.js';
export function toAgentRun(
  companySessionId: CompanySessionId,
  record: EntityRecord<Record<string, unknown>>,
): CompanyAgentRunFileRow {
  const data = record.data;
  const coderSessionId = asSessionId(
    stringValue(data.coder_session_id),
  );
  const rawProjects = Array.isArray(data.project_ids)
    ? data.project_ids.filter(
        (value): value is number => Number.isSafeInteger(value),
      )
    : [];
  return {
    id: asAgentRunId(record.id),
    seq: record.seq,
    company_session_id: companySessionId,
    role: stringValue(data.role),
    coder_session_id: coderSessionId,
    project_ids_json: JSON.stringify(rawProjects),
    provider: stringValue(data.provider),
    model: stringValue(data.model),
    configured_provider: stringValue(
      data.configured_provider,
      stringValue(data.provider),
    ),
    configured_model: stringValue(
      data.configured_model,
      stringValue(data.model),
    ),
    dispatch_source: dispatchSource(data.dispatch_source),
    fallback_reason: nullableString(data.fallback_reason),
    status: runStatus(data.status),
    status_message: stringValue(data.status_message),
    archive_id: nullableString(data.archive_id),
    board_watermark_seq: nonNegativeSafeInteger(data.board_watermark_seq),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function toBoardEntry(
  companySessionId: CompanySessionId,
  record: EntityRecord<Record<string, unknown>>,
): BoardEntry {
  const data = record.data;
  const rawAgentRunId = nullableString(data.agent_run_id);
  const rawArchiveId = nullableString(data.archive_id);
  return {
    id: assertUuid(record.id, 'Company board item id'),
    seq: record.seq,
    company_session_id: companySessionId,
    author_role: stringValue(data.author_role),
    agent_run_id:
      rawAgentRunId == null ? null : asAgentRunId(rawAgentRunId),
    kind: boardKind(data.kind),
    content: stringValue(data.content),
    mentions: stringArray(data.mentions),
    created_at: record.createdAt,
    archive_id:
      rawArchiveId == null
        ? null
        : assertUuid(rawArchiveId, 'Company archive id'),
  };
}

export function parseBoardItemFile(
  companySessionId: CompanySessionId,
  path: string,
): BoardEntry {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe Company board-item entity file ${path}`);
  }
  const record = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as EntityRecord<Record<string, unknown>>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'company.boardItem' ||
    !Number.isSafeInteger(record.seq) ||
    record.seq < 1
  ) {
    throw new Error(`Invalid Company board-item entity envelope ${path}`);
  }
  return toBoardEntry(companySessionId, record);
}

export function toInboxMessage(
  companySessionId: CompanySessionId,
  record: EntityRecord<Record<string, unknown>>,
): AgentInboxMessage {
  const data = record.data;
  return {
    id: assertUuid(record.id, 'Company inbox message id'),
    seq: record.seq,
    company_session_id: companySessionId,
    from_agent_run_id: asAgentRunId(
      stringValue(data.from_agent_run_id),
    ),
    from_role: stringValue(data.from_role),
    to_role: nullableString(data.to_role),
    to_agent_run_id:
      nullableString(data.to_agent_run_id) == null
        ? null
        : asAgentRunId(String(data.to_agent_run_id)),
    kind: inboxKind(data.kind),
    body: stringValue(data.body),
    status: inboxStatus(data.status),
    answer: typeof data.answer === 'string' ? data.answer : null,
    wait_token: nullableString(data.wait_token),
    created_at: record.createdAt,
    delivered_at: nullableString(data.delivered_at),
    answered_at: nullableString(data.answered_at),
    thread_id: nullableUuid(data.thread_id, 'Company inbox thread id'),
    reply_to_message_id: nullableUuid(
      data.reply_to_message_id,
      'Company inbox reply message id',
    ),
    priority: inboxPriority(data.priority),
    context_json: nullableString(data.context_json),
  };
}

export function parseInboxMessageFile(
  companySessionId: CompanySessionId,
  path: string,
): {
  record: EntityRecord<Record<string, unknown>>;
  message: AgentInboxMessage;
} {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe Company inbox-message entity file ${path}`);
  }
  const record = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as EntityRecord<Record<string, unknown>>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'company.inboxMessage' ||
    !Number.isSafeInteger(record.seq) ||
    record.seq < 1
  ) {
    throw new Error(`Invalid Company inbox-message entity envelope ${path}`);
  }
  return {
    record,
    message: toInboxMessage(companySessionId, record),
  };
}

export function toKanbanCard(
  companySessionId: CompanySessionId,
  record: EntityRecord<Record<string, unknown>>,
): KanbanCardFull {
  const data = record.data;
  const id = assertUuid(record.id, 'Company kanban card id');
  const rawArchiveId = nullableString(data.archive_id);
  return {
    id,
    seq: record.seq,
    company_session_id: companySessionId,
    title: stringValue(data.title),
    description: stringValue(data.description),
    column: kanbanColumn(data.column),
    position: nonNegativeSafeInteger(data.position),
    tag: kanbanTag(data.tag),
    created_by: stringValue(data.created_by, 'master'),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    archive_id:
      rawArchiveId == null
        ? null
        : assertUuid(rawArchiveId, 'Company archive id'),
    checklist: kanbanChecklist(id, data.checklist),
    comments: kanbanComments(id, data.comments),
    agents: kanbanAgents(id, data.agents),
    dependencies: kanbanDependencies(id, data.dependencies),
    blocked_by: [],
  };
}

export function parseKanbanCardFile(
  companySessionId: CompanySessionId,
  path: string,
): {
  record: EntityRecord<Record<string, unknown>>;
  card: KanbanCardFull;
} {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe Company kanban-card entity file ${path}`);
  }
  const record = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as EntityRecord<Record<string, unknown>>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'company.kanbanCard' ||
    !Number.isSafeInteger(record.seq) ||
    record.seq < 1
  ) {
    throw new Error(`Invalid Company kanban-card entity envelope ${path}`);
  }
  return {
    record,
    card: toKanbanCard(companySessionId, record),
  };
}

export function parseAgentRunFile(
  companySessionId: CompanySessionId,
  path: string,
): CompanyAgentRunFileRow {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe Company agent-run entity file ${path}`);
  }
  const record = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as EntityRecord<Record<string, unknown>>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'company.agentRun' ||
    !Number.isSafeInteger(record.seq) ||
    record.seq < 1
  ) {
    throw new Error(`Invalid Company agent-run entity envelope ${path}`);
  }
  return toAgentRun(companySessionId, record);
}

export function toMasterPrompt(
  companySessionId: CompanySessionId,
  record: EntityRecord<Record<string, unknown>>,
): MasterPrompt {
  const data = record.data;
  const rawOptions = Array.isArray(data.options) ? data.options : null;
  const options = rawOptions
    ?.filter(
      (value): value is { label: string; value: string } =>
        value != null &&
        typeof value === 'object' &&
        typeof (value as { label?: unknown }).label === 'string' &&
        typeof (value as { value?: unknown }).value === 'string',
    )
    .map((value) => ({ label: value.label, value: value.value })) ?? null;
  return {
    id: record.id,
    company_session_id: companySessionId,
    agent_run_id: nullableString(data.agent_run_id),
    kind: data.kind === 'plan' ? 'plan' : 'question',
    runner_block_id: nullableString(data.runner_block_id),
    body: stringValue(data.body),
    options,
    allow_freeform: data.allow_freeform !== false,
    status:
      data.status === 'answered' || data.status === 'cancelled'
        ? data.status
        : 'pending',
    answer: nullableString(data.answer),
    approved:
      typeof data.approved === 'boolean' ? data.approved : null,
    feedback: nullableString(data.feedback),
    created_at: record.createdAt,
    resolved_at: nullableString(data.resolved_at),
  };
}
