import {
  newSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import { FsSessionDirectory } from './session-directory.js';

export type FsOrchestrationCheckpointKind =
  | 'subagent_resume'
  | 'workflow';

export interface FsOrchestrationCheckpointRow {
  id: string;
  seq: number;
  revision: number;
  session_id: SessionId;
  kind: FsOrchestrationCheckpointKind;
  scope_id: string;
  privacy_class: 'session_private_redacted';
  payload_json: string;
  expires_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FsSaveOrchestrationCheckpointInput {
  sessionId: SessionId;
  kind: FsOrchestrationCheckpointKind;
  scopeId: string;
  privacyClass: 'session_private_redacted';
  payloadJson: string;
  expiresAt: string;
  leaseToken?: string;
}

interface CheckpointData {
  session_id: SessionId;
  checkpoint_type: 'orchestration';
  kind: FsOrchestrationCheckpointKind;
  scope_id: string;
  privacy_class: 'session_private_redacted';
  payload_json: string;
  expires_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
}

function row(
  envelope: FsEntityEnvelope<JsonValue>,
): FsOrchestrationCheckpointRow {
  const data = envelope.data as unknown as CheckpointData;
  return {
    id: envelope.id,
    seq: envelope.seq,
    revision: envelope.revision,
    session_id: data.session_id,
    kind: data.kind,
    scope_id: data.scope_id,
    privacy_class: data.privacy_class,
    payload_json: data.payload_json,
    expires_at: data.expires_at,
    lease_token: data.lease_token,
    lease_expires_at: data.lease_expires_at,
    created_at: envelope.created_at,
    updated_at: envelope.updated_at,
  };
}

function leaseIsActive(data: CheckpointData, now = Date.now()): boolean {
  return (
    data.lease_token != null &&
    data.lease_expires_at != null &&
    Date.parse(data.lease_expires_at) > now
  );
}

/**
 * Durable orchestration recovery state inside one session bundle.
 *
 * The session writer is the cross-process fence. The lease stored here is a
 * second, logical fence between concurrent workflow/resume executors owned by
 * that writer. Expired checkpoints remain on disk for audit; read APIs merely
 * stop treating them as resumable.
 */
export class FsOrchestrationCheckpointRepository {
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {}

  private async envelope(
    sessionId: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    includeExpired = false,
  ): Promise<FsEntityEnvelope<JsonValue> | null> {
    const found = (await this.entities.list<JsonValue>(
      sessionId,
      'checkpoints',
      'orchestration_checkpoint',
    )).find((item) => {
      const data = item.data as unknown as CheckpointData;
      return data.kind === kind && data.scope_id === scopeId;
    });
    if (!found) return null;
    if (
      !includeExpired &&
      Date.parse(
        (found.data as unknown as CheckpointData).expires_at,
      ) <= Date.now()
    ) {
      return null;
    }
    return found;
  }

  async save(
    input: FsSaveOrchestrationCheckpointInput,
  ): Promise<boolean> {
    return this.directory.runMutation(input.sessionId, async () => {
      const existing = await this.envelope(
        input.sessionId,
        input.kind,
        input.scopeId,
        true,
      );
      const operationKey = {
        action: 'save_orchestration_checkpoint',
        kind: input.kind,
        scope_id: input.scopeId,
        payload_json: input.payloadJson,
        expires_at: input.expiresAt,
        lease_token: input.leaseToken ?? null,
      };
      if (!existing) {
        if (input.leaseToken) return false;
        await this.entities.createWithinMutation(
          input.sessionId,
          'checkpoints',
          {
            kind: 'orchestration_checkpoint',
            data: {
              session_id: input.sessionId,
              checkpoint_type: 'orchestration',
              kind: input.kind,
              scope_id: input.scopeId,
              privacy_class: input.privacyClass,
              payload_json: input.payloadJson,
              expires_at: input.expiresAt,
              lease_token: null,
              lease_expires_at: null,
            } satisfies CheckpointData,
            operation_id:
              `checkpoint:${input.kind}:${input.scopeId}:create`,
            operation_key: operationKey,
          },
        );
        return true;
      }

      const current = existing.data as unknown as CheckpointData;
      if (
        leaseIsActive(current) &&
        input.leaseToken !== current.lease_token
      ) {
        return false;
      }
      if (
        input.leaseToken &&
        input.leaseToken !== current.lease_token
      ) {
        return false;
      }
      await this.entities.updateWithinMutation<CheckpointData>(
        input.sessionId,
        'checkpoints',
        existing.id,
        (value) => ({
          ...value,
          privacy_class: input.privacyClass,
          payload_json: input.payloadJson,
          expires_at: input.expiresAt,
        }),
        {
          operation_id:
            `checkpoint:${input.kind}:${input.scopeId}:save:${newSessionId()}`,
          operation_key: operationKey,
        },
      );
      return true;
    });
  }

  async load(
    sessionId: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
  ): Promise<FsOrchestrationCheckpointRow | null> {
    const found = await this.envelope(sessionId, kind, scopeId);
    return found ? row(found) : null;
  }

  async list(
    sessionId: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    limit = 50,
  ): Promise<FsOrchestrationCheckpointRow[]> {
    const now = Date.now();
    return (await this.entities.list<JsonValue>(
      sessionId,
      'checkpoints',
      'orchestration_checkpoint',
    ))
      .map(row)
      .filter(
        (item) =>
          item.kind === kind && Date.parse(item.expires_at) > now,
      )
      .sort((left, right) => right.seq - left.seq)
      .slice(0, Math.max(0, limit));
  }

  async remove(
    sessionId: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    leaseToken?: string,
  ): Promise<void> {
    await this.directory.runMutation(sessionId, async () => {
      const existing = await this.envelope(
        sessionId,
        kind,
        scopeId,
        true,
      );
      if (!existing) return;
      const data = existing.data as unknown as CheckpointData;
      if (
        leaseIsActive(data) &&
        leaseToken !== data.lease_token
      ) {
        return;
      }
      await this.entities.updateWithinMutation<CheckpointData>(
        sessionId,
        'checkpoints',
        existing.id,
        (value) => value,
        {
          delete: true,
          operation_id:
            `checkpoint:${kind}:${scopeId}:remove:${newSessionId()}`,
          operation_key: {
            action: 'remove_orchestration_checkpoint',
            kind,
            scope_id: scopeId,
            lease_token: leaseToken ?? null,
          },
        },
      );
    });
  }

  async tryAcquire(
    sessionId: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    durationMs = 120_000,
  ): Promise<string | null> {
    return this.directory.runMutation(sessionId, async () => {
      const existing = await this.envelope(
        sessionId,
        kind,
        scopeId,
      );
      if (!existing) return null;
      const current = existing.data as unknown as CheckpointData;
      if (leaseIsActive(current)) return null;
      const token = newSessionId();
      const leaseExpiresAt = new Date(
        Date.now() + Math.max(1_000, durationMs),
      ).toISOString();
      await this.entities.updateWithinMutation<CheckpointData>(
        sessionId,
        'checkpoints',
        existing.id,
        (value) => ({
          ...value,
          lease_token: token,
          lease_expires_at: leaseExpiresAt,
        }),
        {
          operation_id:
            `checkpoint:${kind}:${scopeId}:acquire:${token}`,
          operation_key: {
            action: 'acquire_orchestration_checkpoint',
            kind,
            scope_id: scopeId,
            token,
            lease_expires_at: leaseExpiresAt,
          },
        },
      );
      return token;
    });
  }

  async renew(
    sessionId: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    leaseToken: string,
    durationMs = 120_000,
  ): Promise<boolean> {
    return this.directory.runMutation(sessionId, async () => {
      const existing = await this.envelope(
        sessionId,
        kind,
        scopeId,
        true,
      );
      if (!existing) return false;
      const current = existing.data as unknown as CheckpointData;
      if (
        current.lease_token !== leaseToken ||
        !leaseIsActive(current)
      ) {
        return false;
      }
      const leaseExpiresAt = new Date(
        Date.now() + Math.max(1_000, durationMs),
      ).toISOString();
      await this.entities.updateWithinMutation<CheckpointData>(
        sessionId,
        'checkpoints',
        existing.id,
        (value) => ({
          ...value,
          lease_expires_at: leaseExpiresAt,
        }),
        {
          operation_id:
            `checkpoint:${kind}:${scopeId}:renew:${newSessionId()}`,
          operation_key: {
            action: 'renew_orchestration_checkpoint',
            kind,
            scope_id: scopeId,
            lease_token: leaseToken,
            lease_expires_at: leaseExpiresAt,
          },
        },
      );
      return true;
    });
  }

  async release(
    sessionId: SessionId | string,
    kind: FsOrchestrationCheckpointKind,
    scopeId: string,
    leaseToken: string,
  ): Promise<void> {
    await this.directory.runMutation(sessionId, async () => {
      const existing = await this.envelope(
        sessionId,
        kind,
        scopeId,
        true,
      );
      if (!existing) return;
      const current = existing.data as unknown as CheckpointData;
      if (current.lease_token !== leaseToken) return;
      await this.entities.updateWithinMutation<CheckpointData>(
        sessionId,
        'checkpoints',
        existing.id,
        (value) => ({
          ...value,
          lease_token: null,
          lease_expires_at: null,
        }),
        {
          operation_id:
            `checkpoint:${kind}:${scopeId}:release:${newSessionId()}`,
          operation_key: {
            action: 'release_orchestration_checkpoint',
            kind,
            scope_id: scopeId,
            lease_token: leaseToken,
          },
        },
      );
    });
  }
}
