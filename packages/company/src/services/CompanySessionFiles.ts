import {
  CompanySessionRepository,
  assertUuid,
  asAgentRunId,
  asCompanySessionId,
  asSessionId,
  type AgentRunId,
  type CompanySessionId,
  type EntityRecord,
  type SessionId,
  type SessionLocation,
  type SessionMetadata,
} from '@mcp/session-storage';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type {
  AgentRunStatus,
  AgentInboxMessage,
  BoardEntry,
  BoardKind,
  CompanyAgentDispatchSource,
  CompanyRuntimeKind,
  InboxKind,
  InboxPriority,
  InboxStatus,
  KanbanCard,
  KanbanCardAgent,
  KanbanCardDependency,
  KanbanCardFull,
  KanbanChecklistItem,
  KanbanColumn,
  KanbanComment,
  KanbanTag,
  MasterPrompt,
  MasterPromptKind,
  MasterPromptOption,
} from '@mcp/company/types.js';

export interface CompanySessionFileSnapshot {
  id: CompanySessionId;
  template_id: number | null;
  runtime_kind: CompanyRuntimeKind;
  name: string;
  status: string;
  master_session_id: SessionId | null;
  config_json: string;
  parent_session_id: CompanySessionId | null;
  archived_at: string | null;
  recovered_at: string | null;
  recovered_reason: string | null;
  project_ids: number[];
  project_labels: Record<string, string | null>;
  created_at: string;
  updated_at: string;
}

export interface CompanyAgentRunFileRow {
  id: AgentRunId;
  /** Stable entity-envelope creation order; unrelated to board_watermark_seq. */
  seq: number;
  company_session_id: CompanySessionId;
  role: string;
  coder_session_id: SessionId;
  project_ids_json: string;
  provider: string;
  model: string;
  configured_provider: string;
  configured_model: string;
  dispatch_source: CompanyAgentDispatchSource;
  fallback_reason: string | null;
  status: AgentRunStatus;
  status_message: string;
  archive_id: string | null;
  board_watermark_seq: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCompanyAgentRunFileInput {
  role: string;
  coder_session_id: SessionId | string;
  project_ids: readonly number[];
  provider: string;
  model: string;
  configured_provider?: string;
  configured_model?: string;
  dispatch_source?: CompanyAgentDispatchSource;
  fallback_reason?: string | null;
  status?: AgentRunStatus;
  status_message?: string;
}

export interface UpdateCompanyAgentRunRuntimeInput {
  configuredProvider?: string;
  configuredModel?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  dispatchSource?: CompanyAgentDispatchSource;
  fallbackReason?: string | null;
}

export interface ReadCompanyBoardFileOptions {
  sinceSeq?: number;
  limit?: number;
  kind?: BoardKind;
}

export interface CreateCompanyInboxFileInput {
  fromAgentRunId: AgentRunId | string;
  fromRole: string;
  toRole?: string | null;
  toAgentRunId?: AgentRunId | string | null;
  kind: InboxKind;
  body: string;
  waitToken?: string | null;
  threadId?: string | null;
  replyToMessageId?: string | null;
  priority?: InboxPriority;
  contextJson?: string | null;
}

export interface ListCompanyInboxFileOptions {
  status?: InboxStatus | readonly InboxStatus[];
  toRole?: string;
  toAgentRunId?: AgentRunId | string;
  fromAgentRunId?: AgentRunId | string;
  limit?: number;
}

export interface CreateCompanyMasterPromptFileInput {
  agent_run_id: string | null;
  kind: MasterPromptKind;
  runner_block_id?: string | null;
  body: string;
  options?: MasterPromptOption[] | null;
  allow_freeform?: boolean;
}

export type ResolveCompanyMasterPromptFileInput =
  | { kind: 'question'; answer: string }
  | { kind: 'plan'; approved: boolean; feedback?: string };

export type CompanyMasterPromptDeliveryClaim =
  | { kind: 'claimed'; prompt: MasterPrompt; token: string }
  | {
      kind:
        | 'not_pending'
        | 'delivery_in_progress'
        | 'outcome_unknown'
        | 'payload_conflict';
      prompt: MasterPrompt | null;
    };

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function dispatchSource(value: unknown): CompanyAgentDispatchSource {
  return value === 'scheduler' ||
    value === 'manual' ||
    value === 'pipeline' ||
    value === 'fanout' ||
    value === 'app_studio' ||
    value === 'retry'
    ? value
    : 'company';
}

function runStatus(value: unknown): AgentRunStatus {
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

function nonNegativeSafeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

function boardKind(value: unknown): BoardKind {
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Invalid Company board mentions');
  }
  return [...value];
}

const ACTIVE_SUBORDINATE_STATUSES = new Set<AgentRunStatus>([
  'running',
  'working',
  'waiting',
  'waiting_plan',
  'waiting_question',
  'waiting_tasks',
  'reviewing',
  'blocked',
]);

function companyMetadata(session: SessionMetadata): Record<string, unknown> {
  return object(session.metadata.company);
}

function toAgentRun(
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

function toBoardEntry(
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

function parseBoardItemFile(
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

function inboxKind(value: unknown): InboxKind {
  if (value === 'question' || value === 'notify') return value;
  throw new Error(`Invalid Company inbox kind ${String(value)}`);
}

function inboxStatus(value: unknown): InboxStatus {
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

function inboxPriority(value: unknown): InboxPriority {
  if (value === 'low' || value === 'urgent') return value;
  if (value === 'normal' || value == null) return 'normal';
  throw new Error(`Invalid Company inbox priority ${String(value)}`);
}

function nullableUuid(value: unknown, label: string): string | null {
  const raw = nullableString(value);
  return raw == null ? null : assertUuid(raw, label);
}

function toInboxMessage(
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

function parseInboxMessageFile(
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

function inboxRelations(
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

function kanbanColumn(value: unknown): KanbanColumn {
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

function kanbanTag(value: unknown): KanbanTag | null {
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

function kanbanChecklist(
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

function kanbanComments(
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

function kanbanAgents(
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
      unassigned_at: nullableString(row.unassigned_at),
    };
  });
}

function kanbanDependencies(
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

function toKanbanCard(
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

function parseKanbanCardFile(
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

function parseAgentRunFile(
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

type MasterPromptDeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'outcome_unknown';

function promptDeliveryStatus(value: unknown): MasterPromptDeliveryStatus {
  return value === 'delivering' ||
    value === 'delivered' ||
    value === 'outcome_unknown'
    ? value
    : 'pending';
}

function toMasterPrompt(
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

/**
 * Filesystem authority for one Company/App Studio bundle.
 *
 * The class intentionally exposes only bundle-local state. Reusable templates,
 * provider catalogs and skill definitions stay in SQLite and are injected by
 * their dedicated stores.
 */
export class CompanySessionFiles {
  readonly companySessionId: CompanySessionId;
  readonly location: SessionLocation;
  readonly entities: CompanySessionRepository;

  readonly sessionStore: FsSessionStore;
  private nextBoardSequence: number | null = null;
  private nextInboxSequence: number | null = null;
  private nextKanbanSequence: number | null = null;
  private masterPromptMutationTail: Promise<void> = Promise.resolve();

  constructor(input: {
    companySessionId: CompanySessionId | string;
    sessionStore: FsSessionStore;
  }) {
    this.companySessionId = asCompanySessionId(String(input.companySessionId));
    this.sessionStore = input.sessionStore;
    const entry = input.sessionStore.catalog.get(
      asSessionId(this.companySessionId),
    );
    if (!entry) {
      throw new Error(
        `Unknown filesystem Company session ${this.companySessionId}; catalog must be primed before wiring`,
      );
    }
    if (
      entry.session.kind !== 'company' &&
      entry.session.kind !== 'app_studio'
    ) {
      throw new Error(
        `Session ${this.companySessionId} is ${entry.session.kind}, not Company/App Studio`,
      );
    }
    this.location = entry.location;
    this.entities = new CompanySessionRepository({
      sessionRoot: entry.location.bundle_path,
    });
  }

  getSession(): CompanySessionFileSnapshot {
    const session = this.sessionStore.repository.readSessionSync(this.location);
    const state = this.sessionStore.repository.readStateSync(this.location);
    const metadata = companyMetadata(session);
    const labels = object(metadata.project_labels);
    return {
      id: this.companySessionId,
      template_id:
        typeof metadata.template_id === 'number'
          ? metadata.template_id
          : null,
      runtime_kind:
        metadata.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
      name: stringValue(metadata.name, session.title ?? 'Company'),
      status: state.status,
      master_session_id:
        typeof metadata.master_session_id === 'string'
          ? asSessionId(metadata.master_session_id)
          : null,
      config_json: stringValue(metadata.config_json, '{}'),
      parent_session_id:
        session.parent_session_id == null
          ? null
          : asCompanySessionId(session.parent_session_id),
      archived_at: state.archived_at,
      recovered_at: nullableString(metadata.recovered_at),
      recovered_reason: nullableString(metadata.recovered_reason),
      project_ids: session.linked_projects.map((project) => project.project_id),
      project_labels: Object.fromEntries(
        Object.entries(labels).map(([projectId, label]) => [
          projectId,
          typeof label === 'string' ? label : null,
        ]),
      ),
      created_at: session.created_at,
      updated_at:
        Date.parse(state.updated_at) > Date.parse(session.updated_at)
          ? state.updated_at
          : session.updated_at,
    };
  }

  async setMasterSessionId(id: SessionId | string | null): Promise<void> {
    const normalized = id == null ? null : asSessionId(String(id));
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => ({
            ...session,
            metadata: {
              ...session.metadata,
              company: {
                ...companyMetadata(session),
                master_session_id: normalized,
              },
            },
          }) as SessionMetadata,
        );
      },
    );
  }

  async updateSessionStatus(status: string): Promise<void> {
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateState(
          this.location,
          (state) => ({ ...state, status }),
        );
      },
    );
  }

  async updateSessionConfig(configJson: string): Promise<void> {
    const parsed: unknown = JSON.parse(configJson);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Company session config must be a JSON object');
    }
    const normalized = JSON.stringify(parsed);
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => ({
            ...session,
            metadata: {
              ...session.metadata,
              company: {
                ...companyMetadata(session),
                config_json: normalized,
              },
            },
          }) as SessionMetadata,
        );
      },
    );
  }

  async addLinkedProject(input: {
    projectId: number;
    rootPath: string;
    label?: string | null;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.projectId) || input.projectId < 1) {
      throw new TypeError('projectId must be a positive integer');
    }
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => {
            if (
              session.linked_projects.some(
                (project) => project.project_id === input.projectId,
              )
            ) {
              throw new TypeError(
                `Project ${input.projectId} is already linked to Company session ${this.companySessionId}`,
              );
            }
            const metadata = companyMetadata(session);
            const labels = object(metadata.project_labels);
            return {
              ...session,
              linked_projects: [
                ...session.linked_projects,
                {
                  project_id: input.projectId,
                  root_path: input.rootPath,
                },
              ],
              metadata: {
                ...session.metadata,
                company: {
                  ...metadata,
                  project_labels: {
                    ...labels,
                    [String(input.projectId)]: input.label ?? null,
                  },
                },
              },
            } as SessionMetadata;
          },
        );
      },
    );
  }

  async removeLinkedProject(projectId: number): Promise<void> {
    if (!Number.isSafeInteger(projectId) || projectId < 1) {
      throw new TypeError('projectId must be a positive integer');
    }
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => {
            if (session.owner_project_id === projectId) {
              throw new TypeError('The owning Company project cannot be unlinked');
            }
            if (
              !session.linked_projects.some(
                (project) => project.project_id === projectId,
              )
            ) {
              throw new TypeError(
                `Project ${projectId} is not linked to Company session ${this.companySessionId}`,
              );
            }
            const metadata = companyMetadata(session);
            const labels = { ...object(metadata.project_labels) };
            delete labels[String(projectId)];
            return {
              ...session,
              linked_projects: session.linked_projects.filter(
                (project) => project.project_id !== projectId,
              ),
              metadata: {
                ...session.metadata,
                company: {
                  ...metadata,
                  project_labels: labels,
                },
              },
            } as SessionMetadata;
          },
        );
      },
    );
  }

  countActiveSubordinatesAcrossCatalog(): number {
    let active = 0;
    for (const entry of this.sessionStore.catalog.list()) {
      if (
        entry.session.kind !== 'company' &&
        entry.session.kind !== 'app_studio'
      ) {
        continue;
      }
      const files = new CompanySessionFiles({
        companySessionId: entry.session.id,
        sessionStore: this.sessionStore,
      });
      active += files
        .listAgentRunsSync()
        .filter(
          (run) =>
            run.role !== 'master' &&
            run.archive_id == null &&
            ACTIVE_SUBORDINATE_STATUSES.has(run.status),
        )
        .length;
    }
    return active;
  }

  async clearRecoveryFlag(): Promise<void> {
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => ({
            ...session,
            metadata: {
              ...session.metadata,
              company: {
                ...companyMetadata(session),
                recovered_at: null,
                recovered_reason: null,
              },
            },
          }) as SessionMetadata,
        );
      },
    );
  }

  async createAgentRun(
    input: CreateCompanyAgentRunFileInput,
  ): Promise<CompanyAgentRunFileRow> {
    const coderSessionId = asSessionId(String(input.coder_session_id));
    const record = await this.entities.createAgentRun({
      relations: { coder_session_id: coderSessionId },
      data: {
        role: input.role,
        coder_session_id: coderSessionId,
        project_ids: [...new Set(input.project_ids)],
        provider: input.provider,
        model: input.model,
        configured_provider: input.configured_provider ?? input.provider,
        configured_model: input.configured_model ?? input.model,
        dispatch_source: input.dispatch_source ?? 'company',
        fallback_reason: input.fallback_reason ?? null,
        status: input.status ?? 'idle',
        status_message: input.status_message ?? '',
        archive_id: null,
        board_watermark_seq: 0,
      },
    });
    return toAgentRun(
      this.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  async getAgentRun(
    id: AgentRunId | string,
  ): Promise<CompanyAgentRunFileRow | null> {
    const record = await this.entities.get('agentRun', asAgentRunId(String(id)));
    return record
      ? toAgentRun(
          this.companySessionId,
          record as EntityRecord<Record<string, unknown>>,
        )
      : null;
  }

  /**
   * Atomic entity replacement makes lock-free synchronous reads safe: readers
   * observe either the previous complete JSON file or the next one, never a
   * partially written record. Event-oriented Company APIs use this projection
   * where their public contract is intentionally synchronous.
   */
  getAgentRunSync(
    id: AgentRunId | string,
  ): CompanyAgentRunFileRow | null {
    const normalized = asAgentRunId(String(id));
    const path = join(
      this.location.bundle_path,
      'company',
      'agent-runs',
      `${normalized}.json`,
    );
    try {
      return parseAgentRunFile(this.companySessionId, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async listAgentRuns(): Promise<CompanyAgentRunFileRow[]> {
    const page = await this.entities.list('agentRun', {
      limit: 1_000,
      order: 'asc',
    });
    return page.items.map((record) =>
      toAgentRun(
        this.companySessionId,
        record as EntityRecord<Record<string, unknown>>,
      ),
    );
  }

  listAgentRunsSync(): CompanyAgentRunFileRow[] {
    const directory = join(
      this.location.bundle_path,
      'company',
      'agent-runs',
    );
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: Array<{
      seq: number;
      row: CompanyAgentRunFileRow;
    }> = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are forbidden in Company agent runs: ${join(directory, entry.name)}`,
        );
      }
      if (
        !entry.isFile() ||
        !/^[0-9a-f-]{36}\.json$/i.test(entry.name)
      ) {
        continue;
      }
      const path = join(directory, entry.name);
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
      rows.push({
        seq: record.seq,
        row: toAgentRun(this.companySessionId, record),
      });
    }
    rows.sort((left, right) =>
      left.seq - right.seq || left.row.id.localeCompare(right.row.id),
    );
    return rows.map(({ row }) => row);
  }

  async updateAgentRunStatus(
    id: AgentRunId | string,
    status: AgentRunStatus,
    message?: string,
  ): Promise<CompanyAgentRunFileRow> {
    const normalized = asAgentRunId(String(id));
    const previous = await this.entities.get('agentRun', normalized);
    if (!previous) throw new Error(`Unknown Company agent run ${normalized}`);
    const record = await this.entities.update('agentRun', normalized, {
      data: {
        ...previous.data,
        status,
        ...(message === undefined ? {} : { status_message: message }),
      },
    });
    return toAgentRun(
      this.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  async updateAgentRunProvider(
    id: AgentRunId | string,
    provider: string,
    model: string,
    fallbackReason?: string | null,
  ): Promise<CompanyAgentRunFileRow> {
    const normalized = asAgentRunId(String(id));
    const previous = await this.entities.get('agentRun', normalized);
    if (!previous) throw new Error(`Unknown Company agent run ${normalized}`);
    const record = await this.entities.update('agentRun', normalized, {
      data: {
        ...previous.data,
        provider,
        model,
        ...(fallbackReason === undefined
          ? {}
          : { fallback_reason: fallbackReason }),
      },
    });
    return toAgentRun(
      this.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  async updateAgentRunRuntimeSnapshot(
    id: AgentRunId | string,
    input: UpdateCompanyAgentRunRuntimeInput,
  ): Promise<CompanyAgentRunFileRow> {
    const normalized = asAgentRunId(String(id));
    const previous = await this.entities.get('agentRun', normalized);
    if (!previous) throw new Error(`Unknown Company agent run ${normalized}`);
    const record = await this.entities.update('agentRun', normalized, {
      data: {
        ...previous.data,
        ...(input.configuredProvider === undefined
          ? {}
          : { configured_provider: input.configuredProvider }),
        ...(input.configuredModel === undefined
          ? {}
          : { configured_model: input.configuredModel }),
        ...(input.effectiveProvider === undefined
          ? {}
          : { provider: input.effectiveProvider }),
        ...(input.effectiveModel === undefined
          ? {}
          : { model: input.effectiveModel }),
        ...(input.dispatchSource === undefined
          ? {}
          : { dispatch_source: input.dispatchSource }),
        ...(input.fallbackReason === undefined
          ? {}
          : { fallback_reason: input.fallbackReason }),
      },
    });
    return toAgentRun(
      this.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  /** Recoverable deletion: move the independent agent-run record to the
   * session bundle trash. Permanent bundle cleanup remains a separate action. */
  async moveAgentRunToTrash(id: AgentRunId | string): Promise<boolean> {
    const normalized = asAgentRunId(String(id));
    const previous = await this.entities.get('agentRun', normalized);
    if (!previous) return false;
    await this.entities.moveToTrash('agentRun', normalized);
    return true;
  }

  private ensureCompanyEntityDirectorySync(
    directoryName: 'board-items' | 'inbox-messages' | 'kanban-cards',
  ): string {
    let current = this.location.bundle_path;
    const rootStat = lstatSync(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Unsafe Company session bundle ${current}`);
    }
    for (const segment of ['company', directoryName]) {
      current = join(current, segment);
      try {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Unsafe Company entity directory ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(current, { mode: 0o700 });
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Unsafe Company entity directory ${current}`);
        }
      }
    }
    accessSync(current, constants.R_OK | constants.W_OK);
    return current;
  }

  private ensureCompanyTrashDirectorySync(
    directoryName: 'kanban-cards',
  ): string {
    let current = this.location.bundle_path;
    const rootStat = lstatSync(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Unsafe Company session bundle ${current}`);
    }
    for (const segment of ['company', 'trash', directoryName]) {
      current = join(current, segment);
      try {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Unsafe Company trash directory ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(current, { mode: 0o700 });
      }
    }
    accessSync(current, constants.R_OK | constants.W_OK);
    return current;
  }

  private fsyncCompanyDirectoryBestEffortSync(directory: string): void {
    try {
      const handle = openSync(directory, 'r');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== 'EISDIR' &&
        code !== 'EINVAL' &&
        code !== 'ENOTSUP' &&
        code !== 'EPERM' &&
        code !== 'EACCES'
      ) {
        throw error;
      }
    }
  }

  private writeCompanyEntityRecordSync(
    directory: string,
    record: EntityRecord<Record<string, unknown>>,
    createOnly: boolean,
  ): void {
    const target = join(directory, `${record.id}.json`);
    if (createOnly && existsSync(target)) {
      throw new Error(`Company entity ${record.id} already exists`);
    }
    if (!createOnly && !existsSync(target)) {
      throw new Error(`Company entity ${record.id} does not exist`);
    }
    const temp = join(
      directory,
      `.${record.id}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: number | null = null;
    try {
      handle = openSync(temp, 'wx', 0o600);
      writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fsyncSync(handle);
      closeSync(handle);
      handle = null;
      renameSync(temp, target);
      this.fsyncCompanyDirectoryBestEffortSync(directory);
    } catch (error) {
      if (handle != null) {
        try {
          closeSync(handle);
        } catch {
          // Preserve the original write failure.
        }
      }
      try {
        unlinkSync(temp);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new AggregateError(
            [error, cleanupError],
            `Failed to persist and clean up Company entity ${record.id}`,
          );
        }
      }
      throw error;
    }
  }

  createBoardEntry(input: {
    authorRole: string;
    agentRunId: AgentRunId | string | null;
    kind: BoardKind;
    content: string;
    mentions?: readonly string[];
  }): BoardEntry {
    const normalizedAgentRunId =
      input.agentRunId == null
        ? null
        : asAgentRunId(String(input.agentRunId));
    const directory = this.ensureCompanyEntityDirectorySync('board-items');
    const seq =
      this.nextBoardSequence ??
      (
        this.scanBoardEntriesSync(undefined, true).reduce(
          (max, entry) => Math.max(max, entry.seq),
          0,
        ) + 1
      );
    const now = new Date().toISOString();
    const record: EntityRecord<Record<string, unknown>> = {
      schemaVersion: 1,
      id: randomUUID(),
      kind: 'company.boardItem',
      seq,
      operationId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      relations:
        normalizedAgentRunId == null
          ? {}
          : { agent_run_id: normalizedAgentRunId },
      data: {
        author_role: input.authorRole,
        agent_run_id: normalizedAgentRunId,
        kind: input.kind,
        content: input.content,
        mentions: [...new Set(input.mentions ?? [])],
        archive_id: null,
      },
    };
    this.writeCompanyEntityRecordSync(directory, record, true);
    this.nextBoardSequence = seq + 1;
    return toBoardEntry(this.companySessionId, record);
  }

  private scanBoardEntriesSync(
    kind?: BoardKind,
    includeArchived = false,
  ): BoardEntry[] {
    const directory = join(
      this.location.bundle_path,
      'company',
      'board-items',
    );
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const rows: BoardEntry[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are forbidden in Company board items: ${path}`,
        );
      }
      if (
        !entry.isFile() ||
        !/^[0-9a-f-]{36}\.json$/i.test(entry.name)
      ) {
        continue;
      }
      const row = parseBoardItemFile(this.companySessionId, path);
      if (!includeArchived && row.archive_id != null) continue;
      if (kind && row.kind !== kind) continue;
      rows.push(row);
    }
    rows.sort(
      (left, right) =>
        left.seq - right.seq || left.id.localeCompare(right.id),
    );
    return rows;
  }

  listBoardEntriesSync(
    opts: ReadCompanyBoardFileOptions = {},
  ): BoardEntry[] {
    const limit = opts.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('Company board limit must be between 1 and 1000');
    }
    if (
      opts.sinceSeq !== undefined &&
      (
        !Number.isSafeInteger(opts.sinceSeq) ||
        opts.sinceSeq < 0
      )
    ) {
      throw new TypeError('Company board sinceSeq must be a non-negative integer');
    }

    const rows = this.scanBoardEntriesSync(opts.kind).filter(
      (entry) =>
        opts.sinceSeq === undefined || entry.seq > opts.sinceSeq,
    );
    return opts.sinceSeq === undefined
      ? rows.slice(Math.max(0, rows.length - limit))
      : rows.slice(0, limit);
  }

  getAgentBoardWatermarkSync(
    agentRunId: AgentRunId | string,
  ): number {
    return this.getAgentRunSync(agentRunId)?.board_watermark_seq ?? 0;
  }

  async setAgentBoardWatermark(
    agentRunId: AgentRunId | string,
    lastSeenBoardSeq: number,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(lastSeenBoardSeq) ||
      lastSeenBoardSeq < 0
    ) {
      throw new TypeError('Company board watermark must be a non-negative integer');
    }
    const normalized = asAgentRunId(String(agentRunId));
    const previous = await this.entities.get('agentRun', normalized);
    if (!previous) throw new Error(`Unknown Company agent run ${normalized}`);
    const current = nonNegativeSafeInteger(
      previous.data.board_watermark_seq,
    );
    const next = Math.max(current, lastSeenBoardSeq);
    if (next === current) return current;
    await this.entities.update('agentRun', normalized, {
      data: {
        ...previous.data,
        board_watermark_seq: next,
      },
    });
    return next;
  }

  listUnreadBoardCountsSync(): Array<{
    agentRunId: AgentRunId;
    role: string;
    unreadCount: number;
  }> {
    const entries = this.scanBoardEntriesSync();
    return this.listAgentRunsSync().map((run) => ({
      agentRunId: run.id,
      role: run.role,
      unreadCount: entries.filter(
        (entry) =>
          entry.seq > run.board_watermark_seq &&
          entry.agent_run_id !== run.id,
      ).length,
    }));
  }

  private scanKanbanCardsSync(
    includeArchived = false,
  ): Array<{
    record: EntityRecord<Record<string, unknown>>;
    card: KanbanCardFull;
  }> {
    const directory = join(
      this.location.bundle_path,
      'company',
      'kanban-cards',
    );
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: Array<{
      record: EntityRecord<Record<string, unknown>>;
      card: KanbanCardFull;
    }> = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are forbidden in Company kanban cards: ${path}`,
        );
      }
      if (
        !entry.isFile() ||
        !/^[0-9a-f-]{36}\.json$/i.test(entry.name)
      ) {
        continue;
      }
      const parsed = parseKanbanCardFile(this.companySessionId, path);
      if (includeArchived || parsed.card.archive_id == null) rows.push(parsed);
    }
    rows.sort(
      (left, right) =>
        left.card.position - right.card.position ||
        left.card.seq - right.card.seq ||
        left.card.id.localeCompare(right.card.id),
    );
    return rows;
  }

  private getKanbanEnvelopeSync(
    id: string,
  ): {
    record: EntityRecord<Record<string, unknown>>;
    card: KanbanCardFull;
  } | null {
    const normalized = assertUuid(id, 'Company kanban card id');
    const path = join(
      this.location.bundle_path,
      'company',
      'kanban-cards',
      `${normalized}.json`,
    );
    try {
      const parsed = parseKanbanCardFile(this.companySessionId, path);
      if (parsed.card.id !== normalized) {
        throw new Error(`Company kanban id/file-name mismatch in ${path}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private projectKanbanBlockers(
    cards: KanbanCardFull[],
  ): KanbanCardFull[] {
    const byId = new Map(cards.map((card) => [card.id, card]));
    return cards.map((card) => ({
      ...card,
      blocked_by: card.dependencies
        .filter((dependency) => {
          const target = byId.get(dependency.depends_on_id);
          return target != null && target.column !== 'done';
        })
        .map((dependency) => dependency.depends_on_id),
    }));
  }

  private replaceKanbanCardSync(
    id: string,
    updater: (
      card: KanbanCardFull,
      data: Record<string, unknown>,
      now: string,
    ) => Record<string, unknown>,
  ): KanbanCardFull | null {
    const current = this.getKanbanEnvelopeSync(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const record: EntityRecord<Record<string, unknown>> = {
      ...current.record,
      operationId: randomUUID(),
      updatedAt: now,
      data: updater(current.card, current.record.data, now),
    };
    const directory = this.ensureCompanyEntityDirectorySync('kanban-cards');
    this.writeCompanyEntityRecordSync(directory, record, false);
    return this.getKanbanCardFullSync(id);
  }

  createKanbanCardSync(input: {
    title: string;
    description?: string;
    column?: KanbanColumn;
    tag?: KanbanTag | null;
    createdBy?: string;
    checklist?: readonly string[];
  }): KanbanCardFull {
    const title = input.title.trim();
    if (!title) throw new TypeError('Company kanban card title is required');
    const existing = this.scanKanbanCardsSync(true);
    const seq =
      this.nextKanbanSequence ??
      existing.reduce((max, row) => Math.max(max, row.card.seq), 0) + 1;
    const position =
      existing
        .filter((row) => row.card.column === (input.column ?? 'backlog'))
        .reduce((max, row) => Math.max(max, row.card.position), -1) + 1;
    const now = new Date().toISOString();
    const id = randomUUID();
    const checklist = (input.checklist ?? []).map((text, index) => ({
      id: randomUUID(),
      text,
      checked: false,
      position: index,
    }));
    const record: EntityRecord<Record<string, unknown>> = {
      schemaVersion: 1,
      id,
      kind: 'company.kanbanCard',
      seq,
      operationId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      relations: {},
      data: {
        title,
        description: input.description ?? '',
        column: input.column ?? 'backlog',
        position,
        tag: input.tag ?? null,
        created_by: input.createdBy ?? 'master',
        archive_id: null,
        checklist,
        comments: [],
        agents: [],
        dependencies: [],
      },
    };
    const directory = this.ensureCompanyEntityDirectorySync('kanban-cards');
    this.writeCompanyEntityRecordSync(directory, record, true);
    this.nextKanbanSequence = seq + 1;
    return this.getKanbanCardFullSync(id)!;
  }

  listKanbanCardsFullSync(opts?: {
    column?: KanbanColumn;
    includeArchived?: boolean;
  }): KanbanCardFull[] {
    return this.projectKanbanBlockers(
      this.scanKanbanCardsSync(opts?.includeArchived === true)
        .map((row) => row.card),
    ).filter((card) => !opts?.column || card.column === opts.column);
  }

  listKanbanCardsSync(opts?: { column?: KanbanColumn }): KanbanCard[] {
    return this.listKanbanCardsFullSync(opts).map((card) => {
      const {
        checklist: _checklist,
        comments: _comments,
        agents: _agents,
        dependencies: _dependencies,
        blocked_by: _blockedBy,
        ...row
      } = card;
      return row;
    });
  }

  getKanbanCardFullSync(id: string): KanbanCardFull | null {
    const card = this.getKanbanEnvelopeSync(id)?.card ?? null;
    if (!card || card.archive_id != null) return null;
    const all = this.scanKanbanCardsSync().map((row) => row.card);
    return this.projectKanbanBlockers(all)
      .find((candidate) => candidate.id === card.id) ?? null;
  }

  moveKanbanCardSync(
    id: string,
    column: KanbanColumn,
    position?: number,
  ): KanbanCard | null {
    const updated = this.replaceKanbanCardSync(id, (_card, data) => ({
      ...data,
      column,
      ...(position === undefined
        ? {}
        : { position: nonNegativeSafeInteger(position) }),
    }));
    if (!updated) return null;
    const {
      checklist: _checklist,
      comments: _comments,
      agents: _agents,
      dependencies: _dependencies,
      blocked_by: _blockedBy,
      ...card
    } = updated;
    return card;
  }

  updateKanbanCardSync(
    id: string,
    patch: { title?: string; description?: string; tag?: KanbanTag | null },
  ): KanbanCard | null {
    const updated = this.replaceKanbanCardSync(id, (_card, data) => ({
      ...data,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined
        ? {}
        : { description: patch.description }),
      ...(patch.tag === undefined ? {} : { tag: patch.tag }),
    }));
    if (!updated) return null;
    const {
      checklist: _checklist,
      comments: _comments,
      agents: _agents,
      dependencies: _dependencies,
      blocked_by: _blockedBy,
      ...card
    } = updated;
    return card;
  }

  deleteKanbanCardSync(id: string): boolean {
    const current = this.getKanbanEnvelopeSync(id);
    if (!current) return false;
    const dependent = this.listKanbanCardsFullSync().find(
      (candidate) =>
        candidate.id !== current.card.id &&
        candidate.dependencies.some(
          (dependency) => dependency.depends_on_id === current.card.id,
        ),
    );
    if (dependent) {
      throw new Error(
        `Company kanban card ${current.card.id} is still required by ${dependent.id}`,
      );
    }
    const source = join(
      this.ensureCompanyEntityDirectorySync('kanban-cards'),
      `${current.card.id}.json`,
    );
    const trash = this.ensureCompanyTrashDirectorySync('kanban-cards');
    const target = join(trash, `${current.card.id}.json`);
    if (existsSync(target)) {
      throw new Error(`Company kanban trash entry ${current.card.id} exists`);
    }
    renameSync(source, target);
    this.fsyncCompanyDirectoryBestEffortSync(dirname(source));
    this.fsyncCompanyDirectoryBestEffortSync(trash);
    return true;
  }

  addKanbanCommentSync(
    cardId: string,
    authorRole: string,
    agentRunId: string | null,
    content: string,
  ): KanbanComment {
    const normalizedAgentRunId =
      agentRunId == null ? null : asAgentRunId(agentRunId);
    const comment = {
      id: randomUUID(),
      author_role: authorRole,
      agent_run_id: normalizedAgentRunId,
      content,
      created_at: new Date().toISOString(),
    };
    const updated = this.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      comments: [...(Array.isArray(data.comments) ? data.comments : []), comment],
    }));
    if (!updated) throw new Error(`Unknown Company kanban card ${cardId}`);
    return updated.comments.find((row) => row.id === comment.id)!;
  }

  updateKanbanChecklistSync(
    cardId: string,
    items: Array<{ id?: string; text: string; checked: boolean }>,
  ): KanbanChecklistItem[] {
    const current = this.getKanbanCardFullSync(cardId);
    if (!current) throw new Error(`Unknown Company kanban card ${cardId}`);
    const byId = new Map(current.checklist.map((item) => [item.id, item]));
    const next = items.map((item, index) => {
      if (item.id) {
        const normalized = assertUuid(item.id, 'Company checklist item id');
        if (!byId.has(normalized)) {
          throw new Error(`Unknown Company checklist item ${normalized}`);
        }
        return {
          id: normalized,
          text: item.text,
          checked: item.checked,
          position: index,
        };
      }
      return {
        id: randomUUID(),
        text: item.text,
        checked: item.checked,
        position: index,
      };
    });
    const updated = this.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      checklist: next,
    }))!;
    return updated.checklist;
  }

  addKanbanDependencySync(
    cardId: string,
    dependsOnId: string,
  ): KanbanCardDependency {
    const normalizedCardId = assertUuid(cardId, 'Company kanban card id');
    const normalizedDependsOnId = assertUuid(
      dependsOnId,
      'Company kanban dependency target id',
    );
    if (normalizedCardId === normalizedDependsOnId) {
      throw new Error('A Company kanban card cannot depend on itself');
    }
    if (!this.getKanbanCardFullSync(normalizedDependsOnId)) {
      throw new Error(`Unknown dependency target ${normalizedDependsOnId}`);
    }
    const current = this.getKanbanCardFullSync(normalizedCardId);
    if (!current) throw new Error(`Unknown Company kanban card ${normalizedCardId}`);
    const existing = current.dependencies.find(
      (dependency) => dependency.depends_on_id === normalizedDependsOnId,
    );
    if (existing) return existing;
    const cards = this.listKanbanCardsFullSync();
    const byId = new Map(cards.map((card) => [card.id, card]));
    const pending = [normalizedDependsOnId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const candidateId = pending.pop()!;
      if (candidateId === normalizedCardId) {
        throw new Error(
          `Company kanban dependency ${normalizedCardId} -> ${normalizedDependsOnId} creates a cycle`,
        );
      }
      if (visited.has(candidateId)) continue;
      visited.add(candidateId);
      const candidate = byId.get(candidateId);
      if (!candidate) {
        throw new Error(
          `Company kanban dependency graph references missing card ${candidateId}`,
        );
      }
      for (const dependency of candidate.dependencies) {
        pending.push(dependency.depends_on_id);
      }
    }
    const dependency = {
      id: randomUUID(),
      depends_on_id: normalizedDependsOnId,
      created_at: new Date().toISOString(),
    };
    const updated = this.replaceKanbanCardSync(normalizedCardId, (_card, data) => ({
      ...data,
      dependencies: [
        ...(Array.isArray(data.dependencies) ? data.dependencies : []),
        dependency,
      ],
    }))!;
    return updated.dependencies.find((row) => row.id === dependency.id)!;
  }

  removeKanbanDependencySync(
    cardId: string,
    dependsOnId: string,
  ): KanbanCardDependency | null {
    const current = this.getKanbanCardFullSync(cardId);
    if (!current) return null;
    const dependency = current.dependencies.find(
      (row) => row.depends_on_id === dependsOnId,
    );
    if (!dependency) return null;
    this.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      dependencies: (Array.isArray(data.dependencies) ? data.dependencies : [])
        .filter((row) => object(row).id !== dependency.id),
    }));
    return dependency;
  }

  assignKanbanAgentSync(
    cardId: string,
    agentRunId: string,
    role: string,
  ): KanbanCardAgent {
    const normalizedAgentRunId = asAgentRunId(agentRunId);
    // Kanban belongs to the root bundle, while a dispatched subordinate may
    // belong to a child bundle. Keep the UUID as an explicit cross-bundle
    // relation; the spawning workflow validates that run before assignment.
    const assignment = {
      id: randomUUID(),
      agent_run_id: normalizedAgentRunId,
      role,
      assigned_at: new Date().toISOString(),
      unassigned_at: null,
    };
    const updated = this.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      agents: [...(Array.isArray(data.agents) ? data.agents : []), assignment],
    }));
    if (!updated) throw new Error(`Unknown Company kanban card ${cardId}`);
    return updated.agents.find((row) => row.id === assignment.id)!;
  }

  unassignKanbanAgentSync(
    cardId: string,
    agentRunId: string,
  ): KanbanCardAgent | null {
    const current = this.getKanbanCardFullSync(cardId);
    if (!current) return null;
    const assignment = [...current.agents].reverse().find(
      (row) => row.agent_run_id === agentRunId && row.unassigned_at == null,
    );
    if (!assignment) return null;
    const now = new Date().toISOString();
    const updated = this.replaceKanbanCardSync(cardId, (_card, data) => ({
      ...data,
      agents: (Array.isArray(data.agents) ? data.agents : []).map((row) => {
        const value = object(row);
        return value.id === assignment.id
          ? { ...value, unassigned_at: now }
          : value;
      }),
    }))!;
    return updated.agents.find((row) => row.id === assignment.id) ?? null;
  }

  private scanInboxMessagesSync(): Array<{
    record: EntityRecord<Record<string, unknown>>;
    message: AgentInboxMessage;
  }> {
    const directory = join(
      this.location.bundle_path,
      'company',
      'inbox-messages',
    );
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: Array<{
      record: EntityRecord<Record<string, unknown>>;
      message: AgentInboxMessage;
    }> = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are forbidden in Company inbox messages: ${path}`,
        );
      }
      if (
        !entry.isFile() ||
        !/^[0-9a-f-]{36}\.json$/i.test(entry.name)
      ) {
        continue;
      }
      rows.push(parseInboxMessageFile(this.companySessionId, path));
    }
    rows.sort(
      (left, right) =>
        left.message.seq - right.message.seq ||
        left.message.id.localeCompare(right.message.id),
    );
    return rows;
  }

  private getInboxEnvelopeSync(
    id: string,
  ): {
    record: EntityRecord<Record<string, unknown>>;
    message: AgentInboxMessage;
  } | null {
    const normalized = assertUuid(id, 'Company inbox message id');
    const path = join(
      this.location.bundle_path,
      'company',
      'inbox-messages',
      `${normalized}.json`,
    );
    try {
      const parsed = parseInboxMessageFile(this.companySessionId, path);
      if (parsed.message.id !== normalized) {
        throw new Error(`Company inbox id/file-name mismatch in ${path}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  createInboxMessageSync(
    input: CreateCompanyInboxFileInput,
  ): AgentInboxMessage {
    const fromAgentRunId = asAgentRunId(String(input.fromAgentRunId));
    const toAgentRunId =
      input.toAgentRunId == null
        ? null
        : asAgentRunId(String(input.toAgentRunId));
    if (!input.toRole && toAgentRunId == null) {
      throw new TypeError(
        'Company inbox message requires toRole or toAgentRunId',
      );
    }
    if (!this.getAgentRunSync(fromAgentRunId)) {
      throw new Error(`Unknown Company inbox sender ${fromAgentRunId}`);
    }
    if (toAgentRunId && !this.getAgentRunSync(toAgentRunId)) {
      throw new Error(`Unknown Company inbox target ${toAgentRunId}`);
    }
    const threadId =
      input.threadId == null
        ? null
        : assertUuid(input.threadId, 'Company inbox thread id');
    const replyToMessageId =
      input.replyToMessageId == null
        ? null
        : assertUuid(
            input.replyToMessageId,
            'Company inbox reply message id',
          );
    if (threadId && !this.getInboxEnvelopeSync(threadId)) {
      throw new Error(`Unknown Company inbox thread ${threadId}`);
    }
    if (replyToMessageId && !this.getInboxEnvelopeSync(replyToMessageId)) {
      throw new Error(
        `Unknown Company inbox reply target ${replyToMessageId}`,
      );
    }
    if (
      input.waitToken &&
      this.getInboxMessageByWaitTokenSync(input.waitToken)
    ) {
      throw new Error(`Duplicate Company inbox wait token ${input.waitToken}`);
    }
    if (input.contextJson != null) JSON.parse(input.contextJson);
    const kind = inboxKind(input.kind);
    const priority = inboxPriority(input.priority);

    const directory =
      this.ensureCompanyEntityDirectorySync('inbox-messages');
    const seq =
      this.nextInboxSequence ??
      (
        this.scanInboxMessagesSync().reduce(
          (max, item) => Math.max(max, item.message.seq),
          0,
        ) + 1
      );
    const id = randomUUID();
    const now = new Date().toISOString();
    const data: Record<string, unknown> = {
      from_agent_run_id: fromAgentRunId,
      from_role: input.fromRole,
      to_role: input.toRole ?? null,
      to_agent_run_id: toAgentRunId,
      kind,
      body: input.body,
      status: 'pending',
      answer: null,
      wait_token: input.waitToken ?? null,
      delivered_at: null,
      answered_at: null,
      thread_id: threadId ?? id,
      reply_to_message_id: replyToMessageId,
      priority,
      context_json: input.contextJson ?? null,
    };
    const record: EntityRecord<Record<string, unknown>> = {
      schemaVersion: 1,
      id,
      kind: 'company.inboxMessage',
      seq,
      operationId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      relations: inboxRelations(data),
      data,
    };
    this.writeCompanyEntityRecordSync(directory, record, true);
    this.nextInboxSequence = seq + 1;
    return toInboxMessage(this.companySessionId, record);
  }

  getInboxMessageSync(id: string): AgentInboxMessage | null {
    return this.getInboxEnvelopeSync(id)?.message ?? null;
  }

  getInboxMessageByWaitTokenSync(
    token: string,
  ): AgentInboxMessage | null {
    return (
      this.scanInboxMessagesSync().find(
        ({ message }) => message.wait_token === token,
      )?.message ?? null
    );
  }

  listInboxMessagesSync(
    opts: ListCompanyInboxFileOptions = {},
  ): AgentInboxMessage[] {
    const statuses = opts.status == null
      ? null
      : new Set(
          Array.isArray(opts.status) ? opts.status : [opts.status],
        );
    const toAgentRunId =
      opts.toAgentRunId == null
        ? null
        : asAgentRunId(String(opts.toAgentRunId));
    const fromAgentRunId =
      opts.fromAgentRunId == null
        ? null
        : asAgentRunId(String(opts.fromAgentRunId));
    if (
      opts.limit !== undefined &&
      (!Number.isSafeInteger(opts.limit) || opts.limit < 1)
    ) {
      throw new TypeError('Company inbox limit must be a positive integer');
    }
    const rows = this.scanInboxMessagesSync()
      .map(({ message }) => message)
      .filter(
        (message) =>
          (!statuses || statuses.has(message.status)) &&
          (!opts.toRole || message.to_role === opts.toRole) &&
          (!toAgentRunId || message.to_agent_run_id === toAgentRunId) &&
          (!fromAgentRunId ||
            message.from_agent_run_id === fromAgentRunId),
      );
    return opts.limit == null ? rows : rows.slice(0, opts.limit);
  }

  private replaceInboxMessageSync(
    id: string,
    mutate: (
      current: AgentInboxMessage,
      data: Record<string, unknown>,
      now: string,
    ) => Record<string, unknown> | null,
  ): AgentInboxMessage | null {
    const current = this.getInboxEnvelopeSync(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const data = mutate(
      current.message,
      { ...current.record.data },
      now,
    );
    if (!data) return null;
    const record: EntityRecord<Record<string, unknown>> = {
      ...current.record,
      operationId: randomUUID(),
      updatedAt: now,
      relations: inboxRelations(data),
      data,
    };
    const directory =
      this.ensureCompanyEntityDirectorySync('inbox-messages');
    this.writeCompanyEntityRecordSync(directory, record, false);
    return toInboxMessage(this.companySessionId, record);
  }

  claimNextInboxForAgentSync(input: {
    agentRunId: AgentRunId | string;
    role: string;
  }): AgentInboxMessage | null {
    const agentRunId = asAgentRunId(String(input.agentRunId));
    const priority = (value: InboxPriority | undefined): number =>
      value === 'urgent' ? 0 : value === 'low' ? 2 : 1;
    const candidate = this.listInboxMessagesSync({ status: 'pending' })
      .filter(
        (message) =>
          message.to_agent_run_id === agentRunId ||
          (
            message.to_agent_run_id == null &&
            message.to_role === input.role
          ),
      )
      .sort(
        (left, right) =>
          priority(left.priority) - priority(right.priority) ||
          left.seq - right.seq,
      )[0];
    if (!candidate) return null;
    return this.replaceInboxMessageSync(
      candidate.id,
      (current, data, now) =>
        current.status === 'pending'
          ? {
              ...data,
              status: 'delivered',
              delivered_at: now,
              to_agent_run_id: agentRunId,
            }
          : null,
    );
  }

  claimAllPendingMasterMessagesSync(
    masterRole = '__master__',
  ): AgentInboxMessage[] {
    const priority = (value: InboxPriority | undefined): number =>
      value === 'urgent' ? 0 : value === 'low' ? 2 : 1;
    const pending = this.listInboxMessagesSync({
      status: 'pending',
      toRole: masterRole,
    }).sort(
      (left, right) =>
        priority(left.priority) - priority(right.priority) ||
        left.seq - right.seq,
    );
    const claimed: AgentInboxMessage[] = [];
    for (const message of pending) {
      const updated = this.replaceInboxMessageSync(
        message.id,
        (current, data, now) =>
          current.status === 'pending'
            ? {
                ...data,
                status: 'delivered',
                delivered_at: now,
              }
            : null,
      );
      if (updated) claimed.push(updated);
    }
    return claimed;
  }

  answerInboxMessageSync(
    id: string,
    answer: string,
  ): AgentInboxMessage | null {
    return this.replaceInboxMessageSync(
      id,
      (current, data, now) =>
        current.status === 'pending' || current.status === 'delivered'
          ? {
              ...data,
              status: 'answered',
              answer,
              answered_at: now,
            }
          : null,
    );
  }

  setInboxStatusSync(
    id: string,
    status: InboxStatus,
    opts?: { answer?: string },
  ): AgentInboxMessage | null {
    return this.replaceInboxMessageSync(id, (_current, data, now) => ({
      ...data,
      status,
      ...(opts?.answer === undefined ? {} : { answer: opts.answer }),
      ...(
        status === 'answered' ||
        status === 'expired' ||
        status === 'cancelled'
          ? { answered_at: nullableString(data.answered_at) ?? now }
          : {}
      ),
    }));
  }

  listSessionsWithPendingMasterInboxAcrossCatalog(
    masterRole = '__master__',
  ): CompanySessionId[] {
    return listCompanySessionsWithPendingMasterInbox(
      this.sessionStore,
      masterRole,
    );
  }

  private enqueueMasterPromptMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = this.masterPromptMutationTail.then(operation, operation);
    this.masterPromptMutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async createMasterPrompt(
    input: CreateCompanyMasterPromptFileInput,
  ): Promise<MasterPrompt> {
    const record = await this.entities.createMasterPrompt({
      relations: {
        ...(input.agent_run_id
          ? { agent_run_id: input.agent_run_id }
          : {}),
      },
      data: {
        kind: input.kind,
        status: 'pending',
        agent_run_id: input.agent_run_id,
        runner_block_id: input.runner_block_id ?? null,
        body: input.body,
        options: input.options ?? null,
        allow_freeform: input.allow_freeform !== false,
        answer: null,
        approved: null,
        feedback: null,
        resolved_at: null,
        delivery_status: 'pending',
        delivery_token: null,
        delivery_payload_hash: null,
        delivery_started_at: null,
        delivery_completed_at: null,
      },
    });
    return toMasterPrompt(
      this.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  async getPendingMasterPrompt(
    kind?: MasterPromptKind,
  ): Promise<MasterPrompt | null> {
    const page = await this.entities.list('masterPrompt', {
      limit: 1_000,
      order: 'desc',
    });
    const record = page.items.find(
      (candidate) =>
        candidate.data.status === 'pending' &&
        (kind == null || candidate.data.kind === kind),
    );
    return record
      ? toMasterPrompt(
          this.companySessionId,
          record as EntityRecord<Record<string, unknown>>,
        )
      : null;
  }

  async claimMasterPromptDelivery(
    id: string,
    kind: MasterPromptKind,
    token: string,
    payloadHash: string,
    opts?: { retryOutcomeUnknown?: boolean },
  ): Promise<CompanyMasterPromptDeliveryClaim> {
    return this.enqueueMasterPromptMutation(async () => {
      const record = await this.entities.get('masterPrompt', id);
      const prompt = record
        ? toMasterPrompt(
            this.companySessionId,
            record as EntityRecord<Record<string, unknown>>,
          )
        : null;
      if (!record || prompt?.kind !== kind || prompt.status !== 'pending') {
        return { kind: 'not_pending', prompt };
      }
      const currentStatus = promptDeliveryStatus(
        record.data.delivery_status,
      );
      const currentHash = nullableString(
        record.data.delivery_payload_hash,
      );
      const canRetry =
        opts?.retryOutcomeUnknown === true &&
        (
          currentStatus === 'outcome_unknown' ||
          currentStatus === 'delivering'
        );
      if (currentStatus !== 'pending' && !canRetry) {
        return {
          kind:
            currentStatus === 'delivering'
              ? 'delivery_in_progress'
              : 'outcome_unknown',
          prompt,
        };
      }
      if (canRetry && currentHash !== payloadHash) {
        return { kind: 'payload_conflict', prompt };
      }
      const updated = await this.entities.update('masterPrompt', id, {
        data: {
          ...record.data,
          delivery_status: 'delivering',
          delivery_token: token,
          delivery_payload_hash: payloadHash,
          delivery_started_at: new Date().toISOString(),
          delivery_completed_at: null,
        },
      });
      return {
        kind: 'claimed',
        prompt: toMasterPrompt(
          this.companySessionId,
          updated as EntityRecord<Record<string, unknown>>,
        ),
        token,
      };
    });
  }

  async releaseMasterPromptDelivery(
    id: string,
    token: string,
  ): Promise<boolean> {
    return this.enqueueMasterPromptMutation(async () => {
      const record = await this.entities.get('masterPrompt', id);
      if (
        !record ||
        record.data.status !== 'pending' ||
        record.data.delivery_status !== 'delivering' ||
        record.data.delivery_token !== token
      ) {
        return false;
      }
      await this.entities.update('masterPrompt', id, {
        data: {
          ...record.data,
          delivery_status: 'pending',
          delivery_token: null,
          delivery_payload_hash: null,
          delivery_started_at: null,
          delivery_completed_at: null,
        },
      });
      return true;
    });
  }

  async markMasterPromptDeliveryOutcomeUnknown(
    id: string,
    token: string,
  ): Promise<boolean> {
    return this.enqueueMasterPromptMutation(async () => {
      const record = await this.entities.get('masterPrompt', id);
      if (
        !record ||
        record.data.status !== 'pending' ||
        record.data.delivery_status !== 'delivering' ||
        record.data.delivery_token !== token
      ) {
        return false;
      }
      await this.entities.update('masterPrompt', id, {
        data: {
          ...record.data,
          delivery_status: 'outcome_unknown',
          delivery_completed_at: new Date().toISOString(),
        },
      });
      return true;
    });
  }

  async completeMasterPromptDelivery(
    id: string,
    token: string,
    resolution: ResolveCompanyMasterPromptFileInput,
  ): Promise<MasterPrompt | null> {
    return this.enqueueMasterPromptMutation(async () => {
      const record = await this.entities.get('masterPrompt', id);
      if (
        !record ||
        record.data.kind !== resolution.kind ||
        record.data.status !== 'pending' ||
        record.data.delivery_status !== 'delivering' ||
        record.data.delivery_token !== token
      ) {
        return null;
      }
      const resolvedAt = new Date().toISOString();
      const updated = await this.entities.update('masterPrompt', id, {
        data: {
          ...record.data,
          status: 'answered',
          answer:
            resolution.kind === 'question' ? resolution.answer : null,
          approved:
            resolution.kind === 'plan' ? resolution.approved : null,
          feedback:
            resolution.kind === 'plan'
              ? resolution.feedback ?? null
              : null,
          resolved_at: resolvedAt,
          delivery_status: 'delivered',
          delivery_completed_at: resolvedAt,
        },
      });
      return toMasterPrompt(
        this.companySessionId,
        updated as EntityRecord<Record<string, unknown>>,
      );
    });
  }

  async cancelPendingMasterPrompts(): Promise<MasterPrompt[]> {
    return this.enqueueMasterPromptMutation(async () => {
      const page = await this.entities.list('masterPrompt', {
        limit: 1_000,
        order: 'asc',
      });
      const cancelled: MasterPrompt[] = [];
      for (const record of page.items) {
        if (record.data.status !== 'pending') continue;
        const resolvedAt = new Date().toISOString();
        const updated = await this.entities.update(
          'masterPrompt',
          record.id,
          {
            data: {
              ...record.data,
              status: 'cancelled',
              resolved_at: resolvedAt,
            },
          },
        );
        cancelled.push(
          toMasterPrompt(
            this.companySessionId,
            updated as EntityRecord<Record<string, unknown>>,
          ),
        );
      }
      return cancelled;
    });
  }
}

/**
 * Scan the in-memory filesystem session catalog for dormant Company/App
 * sessions that still owe work to their master inbox. Callers must initialize
 * the catalog first; no SQLite catalog or session fallback is consulted.
 */
export function listCompanySessionsWithPendingMasterInbox(
  sessionStore: FsSessionStore,
  masterRole = '__master__',
): CompanySessionId[] {
  const sessions: CompanySessionId[] = [];
  for (const entry of sessionStore.catalog.list()) {
    if (
      entry.session.kind !== 'company' &&
      entry.session.kind !== 'app_studio'
    ) {
      continue;
    }
    const files = new CompanySessionFiles({
      companySessionId: entry.session.id,
      sessionStore,
    });
    if (
      files.listInboxMessagesSync({
        status: 'pending',
        toRole: masterRole,
        limit: 1,
      }).length > 0
    ) {
      sessions.push(files.companySessionId);
    }
  }
  return sessions;
}
