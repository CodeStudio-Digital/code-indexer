import { createHash } from 'node:crypto';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import type {
  SessionWorkbenchCommand,
  SessionWorkbenchCommandResult,
  SessionWorkbenchEvent,
  SessionWorkbenchResource,
} from '@mcp/api-bus';
import type { FsSessionEvent } from '@mcp/session-storage/fs-store/operational-types.js';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/types.js';

const RECEIPT_TYPE = 'workbench.command.applied';
const MAX_IN_FLIGHT_COMMANDS = 128;

type CommandStore = {
  getSession(id: SessionId): Promise<FsCoderSession | null>;
  setSessionTitle(id: SessionId, title: string): Promise<void>;
  setSessionFavorite(id: SessionId, favorite: boolean): Promise<void>;
  setSessionArchived(id: SessionId, archived: boolean): Promise<void>;
  setSessionGroup(id: SessionId, groupId: string | null): Promise<void>;
  duplicateSession(
    id: SessionId,
    options: { targetId: SessionId; title?: string },
  ): Promise<FsCoderSession>;
  setSessionToolDisabled(id: SessionId, toolId: string, disabled: boolean): Promise<void>;
  setSessionActiveSkills(id: SessionId, skillIds: readonly string[]): Promise<void>;
  appendSessionEvent(
    id: SessionId,
    type: string,
    payload: unknown,
    operationId?: string,
  ): Promise<FsSessionEvent>;
  getSessionEventByOperationId(
    id: SessionId,
    operationId: string,
    type?: string,
  ): Promise<FsSessionEvent | null>;
};

export type SessionWorkbenchEnabledSkillResolver = (
  session: FsCoderSession,
) => Promise<Set<string>>;

export type SessionWorkbenchCommandEventPublisher = (
  event: SessionWorkbenchEvent,
) => void | Promise<void>;

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function revision(session: FsCoderSession): number {
  const parsed = Date.parse(session.updated_at);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function fingerprint(command: SessionWorkbenchCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function operationId(commandId: string): string {
  return `workbench-command:${commandId}`;
}

function failure(
  command: SessionWorkbenchCommand,
  code: string,
  message: string,
  retryable: boolean,
  resource: SessionWorkbenchResource | null = null,
): SessionWorkbenchCommandResult {
  return {
    commandId: command.commandId,
    sessionId: command.sessionId,
    ok: false,
    error: { code, message, retryable, sessionId: command.sessionId, resource },
  };
}

function receiptResult(event: FsSessionEvent, command: SessionWorkbenchCommand): SessionWorkbenchCommandResult | null {
  const payload = object(event.payload);
  if (payload.fingerprint !== fingerprint(command)) {
    return failure(command, 'command_id_conflict', 'commandId was already used with different input', false);
  }
  const stored = object(payload.result);
  if (
    stored.ok !== true
    || stored.commandId !== command.commandId
    || stored.sessionId !== command.sessionId
    || !Number.isSafeInteger(stored.revision)
  ) return failure(command, 'invalid_command_receipt', 'persisted command receipt is invalid', false);
  return {
    commandId: command.commandId,
    sessionId: command.sessionId,
    ok: true,
    revision: Number(stored.revision),
    ...(typeof stored.createdSessionId === 'string'
      ? { createdSessionId: asSessionId(stored.createdSessionId) }
      : {}),
  };
}

function commandEvent(
  command: SessionWorkbenchCommand,
  receipt: FsSessionEvent,
  result: Extract<SessionWorkbenchCommandResult, { ok: true }>,
): SessionWorkbenchEvent | null {
  const base = {
    sessionId: command.sessionId,
    busId: `command:${command.sessionId}`,
    seq: receipt.seq,
    revision: result.revision,
    occurredAt: receipt.created_at,
  };
  if (command.type === 'rename' || command.type === 'set_favorite' || command.type === 'set_archived' || command.type === 'move') {
    return {
      ...base,
      type: 'navigator.changed',
      resource: 'navigator',
      data: {
        titleChanged: command.type === 'rename',
        statusChanged: false,
        favoriteChanged: command.type === 'set_favorite',
        archivedChanged: command.type === 'set_archived',
        groupChanged: command.type === 'move',
        unreadChanged: false,
      },
    };
  }
  if (command.type === 'set_skill_enabled' || command.type === 'set_tool_enabled') {
    return {
      ...base,
      type: 'configuration.changed',
      resource: 'configuration',
      data: { views: [command.type === 'set_skill_enabled' ? 'skills' : 'tools'] },
    };
  }
  return null;
}

export class SessionWorkbenchCommandService {
  private readonly inFlight = new Map<string, Promise<SessionWorkbenchCommandResult>>();

  constructor(
    private readonly store: CommandStore,
    private readonly resolveEnabledSkills: SessionWorkbenchEnabledSkillResolver,
    private readonly publish?: SessionWorkbenchCommandEventPublisher,
  ) {}

  execute(command: SessionWorkbenchCommand): Promise<SessionWorkbenchCommandResult> {
    const key = `${command.sessionId}:${command.commandId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.executeOnce(command).finally(() => this.inFlight.delete(key));
    if (this.inFlight.size >= MAX_IN_FLIGHT_COMMANDS) {
      const oldest = this.inFlight.keys().next().value as string | undefined;
      if (oldest) this.inFlight.delete(oldest);
    }
    this.inFlight.set(key, pending);
    return pending;
  }

  async batch(commands: readonly SessionWorkbenchCommand[]): Promise<SessionWorkbenchCommandResult[]> {
    const results: SessionWorkbenchCommandResult[] = [];
    for (const command of commands) results.push(await this.execute(command));
    return results;
  }

  private async executeOnce(command: SessionWorkbenchCommand): Promise<SessionWorkbenchCommandResult> {
    const session = await this.store.getSession(command.sessionId);
    if (!session) return failure(command, 'session_not_found', 'session does not exist', false, 'navigator');

    const prior = await this.store.getSessionEventByOperationId(
      command.sessionId,
      operationId(command.commandId),
      RECEIPT_TYPE,
    );
    if (prior) return receiptResult(prior, command)!;

    const currentRevision = revision(session);
    const alreadyApplied = await this.isAlreadyApplied(session, command);
    if (
      command.expectedRevision !== undefined
      && command.expectedRevision !== currentRevision
      && !alreadyApplied
    ) {
      return failure(
        command,
        'revision_conflict',
        'session changed after the command snapshot',
        true,
        command.type === 'set_skill_enabled' || command.type === 'set_tool_enabled'
          ? 'configuration'
          : 'navigator',
      );
    }

    let createdSessionId: SessionId | undefined;
    try {
      if (command.type === 'rename' && !alreadyApplied) await this.store.setSessionTitle(command.sessionId, command.title);
      else if (command.type === 'set_favorite' && !alreadyApplied) await this.store.setSessionFavorite(command.sessionId, command.favorite);
      else if (command.type === 'set_archived' && !alreadyApplied) await this.store.setSessionArchived(command.sessionId, command.archived);
      else if (command.type === 'move' && !alreadyApplied) await this.store.setSessionGroup(command.sessionId, command.groupId);
      else if (command.type === 'duplicate') {
        const created = await this.store.duplicateSession(command.sessionId, {
          targetId: asSessionId(command.commandId),
          ...(command.title ? { title: command.title } : {}),
        });
        createdSessionId = created.id;
      } else if (command.type === 'set_tool_enabled' && !alreadyApplied) {
        await this.store.setSessionToolDisabled(command.sessionId, command.toolId, !command.enabled);
      } else if (command.type === 'set_skill_enabled' && !alreadyApplied) {
        const active = await this.resolveEnabledSkills(session);
        if (command.enabled) active.add(command.skillId);
        else active.delete(command.skillId);
        await this.store.setSessionActiveSkills(command.sessionId, [...active].sort());
      } else if (command.type === 'mark_notifications_read' || command.type === 'dismiss_notification') {
        return failure(command, 'command_not_implemented', 'notification command is not available yet', false, 'navigator');
      }
    } catch (error) {
      return failure(
        command,
        'command_failed',
        error instanceof Error ? error.message : 'command failed',
        false,
        command.type === 'set_skill_enabled' || command.type === 'set_tool_enabled'
          ? 'configuration'
          : 'navigator',
      );
    }

    const refreshed = await this.store.getSession(command.sessionId);
    const result: Extract<SessionWorkbenchCommandResult, { ok: true }> = {
      commandId: command.commandId,
      sessionId: command.sessionId,
      ok: true,
      revision: refreshed ? revision(refreshed) : currentRevision,
      ...(createdSessionId ? { createdSessionId } : {}),
    };
    let receipt: FsSessionEvent;
    try {
      receipt = await this.store.appendSessionEvent(
        command.sessionId,
        RECEIPT_TYPE,
        { fingerprint: fingerprint(command), result },
        operationId(command.commandId),
      );
    } catch (error) {
      return failure(
        command,
        'command_receipt_failed',
        error instanceof Error ? error.message : 'command receipt could not be persisted',
        true,
      );
    }
    const event = commandEvent(command, receipt, result);
    if (event) {
      try { await this.publish?.(event); } catch { /* persisted receipt remains authoritative */ }
    }
    return result;
  }

  private async isAlreadyApplied(
    session: FsCoderSession,
    command: SessionWorkbenchCommand,
  ): Promise<boolean> {
    if (command.type === 'rename') return session.title === command.title;
    if (command.type === 'set_favorite') return session.is_favorite === command.favorite;
    if (command.type === 'set_archived') return session.is_archived === command.archived;
    if (command.type === 'move') return session.group_id === command.groupId;
    if (command.type === 'set_tool_enabled') {
      const disabled = Array.isArray(session.state.tools.disabled)
        ? session.state.tools.disabled.filter((value): value is string => typeof value === 'string')
        : [];
      return disabled.includes(command.toolId) === !command.enabled;
    }
    if (command.type === 'set_skill_enabled') {
      const active = await this.resolveEnabledSkills(session);
      return active.has(command.skillId) === command.enabled;
    }
    return false;
  }
}
