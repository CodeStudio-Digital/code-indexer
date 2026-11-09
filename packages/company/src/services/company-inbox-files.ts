import { toInboxMessage, parseInboxMessageFile } from './company-session-file-codecs.js';
import { nullableString, inboxKind, inboxPriority, inboxRelations } from './company-session-file-values.js';
import type { CreateCompanyInboxFileInput, ListCompanyInboxFileOptions } from './company-session-file-types.js';
import { assertUuid, asAgentRunId, type AgentRunId, type EntityRecord } from '@mcp/session-storage';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { AgentInboxMessage, InboxPriority, InboxStatus } from '@mcp/company/types.js';
import { CompanySessionFileBase } from './company-session-file-base.js';
import { CompanyAgentRunFiles } from './company-agent-run-files.js';

export class CompanyInboxFiles {
  constructor(private readonly context: CompanySessionFileBase, private readonly agentRuns: CompanyAgentRunFiles) {}

  private nextInboxSequence: number | null = null;

  private scanInboxMessagesSync(): Array<{
    record: EntityRecord<Record<string, unknown>>;
    message: AgentInboxMessage;
  }> {
    const directory = join(
      this.context.location.bundle_path,
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
      rows.push(parseInboxMessageFile(this.context.companySessionId, path));
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
      this.context.location.bundle_path,
      'company',
      'inbox-messages',
      `${normalized}.json`,
    );
    try {
      const parsed = parseInboxMessageFile(this.context.companySessionId, path);
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
    let source = this.context;
    let sourceRuns = this.agentRuns;
    if (input.fromSessionId && input.fromSessionId !== this.context.companySessionId) {
      source = new CompanySessionFileBase({ companySessionId: input.fromSessionId, sessionStore: this.context.sessionStore });
      const senderSession = source.getSession(); const targetSession = this.context.getSession();
      if ((senderSession.parent_session_id ?? senderSession.id) !== (targetSession.parent_session_id ?? targetSession.id)) throw new Error('Company inbox cannot cross company boundaries');
      sourceRuns = new CompanyAgentRunFiles(source);
    }
    if (input.origin === 'operator' ? String(fromAgentRunId) !== String(source.companySessionId) : !sourceRuns.getAgentRunSync(fromAgentRunId)) {
      throw new Error(`Unknown Company inbox sender ${fromAgentRunId}`);
    }
    if (toAgentRunId && !this.agentRuns.getAgentRunSync(toAgentRunId)) {
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
      this.context.ensureCompanyEntityDirectorySync('inbox-messages');
    const seq =
      this.nextInboxSequence ??
      (
        this.scanInboxMessagesSync().reduce(
          (max, item) => Math.max(max, item.message.seq),
          0,
        ) + 1
      );
    const id = input.id ? assertUuid(input.id, 'Company inbox message id') : randomUUID();
    const now = new Date().toISOString();
    const data: Record<string, unknown> = {
      from_agent_run_id: fromAgentRunId,
      from_session_id: source.companySessionId,
      to_session_id: this.context.companySessionId,
      origin: input.origin ?? 'agent',
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
    this.context.writeCompanyEntityRecordSync(directory, record, true);
    this.nextInboxSequence = seq + 1;
    return toInboxMessage(this.context.companySessionId, record);
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
      this.context.ensureCompanyEntityDirectorySync('inbox-messages');
    this.context.writeCompanyEntityRecordSync(directory, record, false);
    return toInboxMessage(this.context.companySessionId, record);
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
}
