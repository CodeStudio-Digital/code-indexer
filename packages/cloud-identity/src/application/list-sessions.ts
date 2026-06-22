/** List the account's active sessions (devices), flagging the current one. */
import { type Result, ok, type AccountId, type SessionId } from '@cloudstudio/cloud-kernel';
import type { IdentityError } from '../domain/errors.js';
import type { SessionRepo } from '../domain/ports.js';

export interface SessionView {
  id: string;
  userAgent: string | null;
  deviceName: string | null;
  osRelease: string | null;
  geoCountry: string | null;
  geoCity: string | null;
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
        deviceName: r.deviceName,
        osRelease: r.osRelease,
        geoCountry: r.geoCountry,
        geoCity: r.geoCity,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        current: r.id === input.currentSessionId,
      })),
    );
  }
}
