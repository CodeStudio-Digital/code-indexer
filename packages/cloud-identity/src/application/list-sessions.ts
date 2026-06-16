/** List the account's active sessions (devices), flagging the current one. */
import { type Result, ok, type AccountId, type SessionId } from '@cloudstudio/cloud-kernel';
import type { IdentityError } from '../domain/errors.js';
import type { SessionRepo } from '../domain/ports.js';

export interface SessionView {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export class ListSessionsUseCase {
  constructor(private readonly sessions: SessionRepo) {}
  async execute(input: {
    accountId: AccountId;
    currentSessionId: SessionId;
  }): Promise<Result<SessionView[], IdentityError>> {
    const rows = await this.sessions.listByAccount(input.accountId);
    return ok(
      rows.map((r) => ({
        id: r.id,
        userAgent: r.userAgent,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        current: r.id === input.currentSessionId,
      })),
    );
  }
}
