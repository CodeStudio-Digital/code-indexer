import {
  isUuid,
  newSessionId,
  type ArtifactReader,
  type ArtifactStore,
  type ArtifactRef,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import type {
  ReviewFateAggregate,
  ReviewFateInput,
  ReviewIntelPort,
  RecentDismissal,
} from '../contracts/review-intel-port.js';
import type {
  CreateCommentInput,
  SessionReviewStorePort,
  SnapshotReviewComment,
  SnapshotReviewRun,
  SnapshotReviewRunStatus,
  SnapshotReviewSource,
} from '../contracts/session-snapshot-port.js';
import { FsSessionEntityFiles, type FsEntityEnvelope } from './entity-files.js';
import {
  hydrateReviewComment,
  hydrateReviewRun,
  parseIntentContract,
  parseReviewComment,
  parseReviewFate,
  parseReviewRun,
} from './review-files-codec.js';
import { FsSessionDirectory } from './session-directory.js';
import type { FsSessionSnapshotRepository } from './snapshot-repository.js';
import type {
  StoredIntentContract,
  StoredReviewComment,
  StoredReviewFate,
  StoredReviewRun,
} from './snapshot-files-codec.js';
import { validateSnapshotFilePath } from './snapshot-files-codec.js';

type Entity = FsEntityEnvelope<JsonValue>;

export class FsSessionReviewRepository
  implements
    SessionReviewStorePort<SessionId, string>,
    ReviewIntelPort<SessionId, string>
{
  readonly #recordOwners = new Map<string, SessionId>();

  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
    private readonly snapshots: FsSessionSnapshotRepository,
  ) {}

  async #list(sessionId: SessionId, kind?: string): Promise<Entity[]> {
    const rows = await this.entities.list<JsonValue>(
      sessionId,
      'snapshots',
      kind,
    );
    for (const row of rows) this.#recordOwners.set(row.id, sessionId);
    return rows;
  }

  async #locate(id: string, kind: string): Promise<{ sessionId: SessionId; record: Entity } | null> {
    if (!isUuid(id)) return null;
    const cached = this.#recordOwners.get(id);
    if (cached) {
      const record = await this.entities.get<JsonValue>(cached, 'snapshots', id);
      if (record?.kind === kind) return { sessionId: cached, record };
      this.#recordOwners.delete(id);
    }
    await this.directory.ensureCatalog();
    let found: { sessionId: SessionId; record: Entity } | null = null;
    for (const entry of this.directory.catalog.list()) {
      const record = await this.entities.get<JsonValue>(
        entry.session.id,
        'snapshots',
        id,
      );
      if (!record || record.kind !== kind) continue;
      if (found) throw new Error(`Duplicate review UUID ${id}`);
      found = { sessionId: entry.session.id, record };
    }
    if (found) this.#recordOwners.set(id, found.sessionId);
    return found;
  }

  async #artifactStore(sessionId: SessionId): Promise<ArtifactStore> {
    const entry = await this.directory.requireEntry(sessionId);
    return this.directory.repository.artifactStore(entry.location);
  }

  async #artifactReader(sessionId: SessionId): Promise<ArtifactReader> {
    const entry = await this.directory.requireEntry(sessionId);
    return this.directory.repository.artifactReader(entry.location);
  }

  async #putRaw(
    sessionId: SessionId,
    raw: string | null | undefined,
    logicalName: string,
  ): Promise<ArtifactRef | null> {
    if (raw == null) return null;
    return (await this.#artifactStore(sessionId)).put({
      kind: 'snapshot_blob',
      data: raw,
      media_type: 'application/json; charset=utf-8',
      logical_name: logicalName,
    });
  }

  async createRun(input: {
    session_kind: string;
    session_id: SessionId;
    source: SnapshotReviewSource;
    status?: SnapshotReviewRunStatus;
    operation_id?: string;
  }): Promise<SnapshotReviewRun<SessionId, string>> {
    const data: StoredReviewRun = {
      session_kind: input.session_kind,
      session_id: input.session_id,
      source: input.source,
      status: input.status ?? 'running',
      provider_id: null,
      model_id: null,
      raw_response: null,
      error: null,
      completed_at: null,
    };
    const record = await this.entities.create(input.session_id, 'snapshots', {
      kind: 'review_run',
      data,
      operation_id: input.operation_id,
      operation_key: input,
    });
    this.#recordOwners.set(record.id, input.session_id);
    return hydrateReviewRun(record, await this.#artifactReader(input.session_id));
  }

  async getRun(id: string): Promise<SnapshotReviewRun<SessionId, string> | null> {
    const located = await this.#locate(id, 'review_run');
    return located
      ? hydrateReviewRun(
          located.record,
          await this.#artifactReader(located.sessionId),
        )
      : null;
  }

  async completeRun(
    id: string,
    patch: {
      status: SnapshotReviewRunStatus;
      provider_id?: string | null;
      model_id?: string | null;
      raw_response?: string | null;
      error?: string | null;
      operation_id?: string;
    },
  ): Promise<void> {
    const located = await this.#locate(id, 'review_run');
    if (!located) return;
    const raw = await this.#putRaw(
      located.sessionId,
      patch.raw_response,
      `${id}.review-response`,
    );
    await this.entities.update<StoredReviewRun>(
      located.sessionId,
      'snapshots',
      id,
      (current) => ({
        ...current,
        status: patch.status,
        provider_id:
          patch.provider_id === undefined
            ? current.provider_id
            : patch.provider_id,
        model_id:
          patch.model_id === undefined ? current.model_id : patch.model_id,
        raw_response:
          patch.raw_response === undefined ? current.raw_response : raw,
        error: patch.error === undefined ? current.error : patch.error,
        completed_at: new Date().toISOString(),
      }),
      {
        operation_id: patch.operation_id,
        operation_key: patch,
      },
    );
  }

  async listRuns(
    sessionKind: string,
    sessionId: SessionId,
  ): Promise<SnapshotReviewRun<SessionId, string>[]> {
    const store = await this.#artifactReader(sessionId);
    return (await this.#list(sessionId, 'review_run'))
      .filter((row) => {
        const data = parseReviewRun(row.data);
        return data.session_kind === sessionKind && data.session_id === sessionId;
      })
      .sort((left, right) => right.seq - left.seq)
      .map((row) => hydrateReviewRun(row, store));
  }

  async createComment(
    input: CreateCommentInput<string>,
  ): Promise<SnapshotReviewComment<string>> {
    validateSnapshotFilePath(input.file_path);
    const sessionId = await this.snapshots.sessionIdForBaseline(input.baseline_id);
    if (!sessionId) throw new Error(`Unknown snapshot baseline ${input.baseline_id}`);
    if (input.run_id) {
      const run = await this.#locate(input.run_id, 'review_run');
      if (!run || run.sessionId !== sessionId) {
        throw new Error('Review comment run belongs to another session');
      }
    }
    const data: StoredReviewComment = {
      session_id: sessionId,
      run_id: input.run_id ?? null,
      baseline_id: input.baseline_id,
      source: input.source,
      status: input.status ?? 'open',
      file_path: input.file_path,
      hunk_fingerprint: input.hunk_fingerprint ?? null,
      old_line: input.old_line ?? null,
      new_line: input.new_line ?? null,
      severity: input.severity ?? null,
      kind: input.kind ?? 'defect',
      obligation_id: input.obligation_id ?? null,
      symbol_anchor: input.symbol_anchor ?? null,
      body: input.body,
      suggested_fix: input.suggested_fix ?? null,
      diff_excerpt: input.diff_excerpt ?? null,
    };
    const row = await this.entities.create(sessionId, 'snapshots', {
      kind: 'review_comment',
      data,
      operation_id: input.operation_id,
      operation_key: input,
    });
    this.#recordOwners.set(row.id, sessionId);
    return hydrateReviewComment(row);
  }

  async getComment(id: string): Promise<SnapshotReviewComment<string> | null> {
    const located = await this.#locate(id, 'review_comment');
    return located ? hydrateReviewComment(located.record) : null;
  }

  async listComments(
    sessionKind: string,
    sessionId: SessionId,
  ): Promise<SnapshotReviewComment<string>[]> {
    const session = await this.directory.requireEntry(sessionId);
    if (session.session.kind !== sessionKind) return [];
    return (await this.#list(sessionId, 'review_comment')).map(hydrateReviewComment);
  }

  async #allComments(): Promise<Array<{ sessionId: SessionId; row: Entity }>> {
    await this.directory.ensureCatalog();
    const result: Array<{ sessionId: SessionId; row: Entity }> = [];
    for (const entry of this.directory.catalog.list()) {
      for (const row of await this.#list(entry.session.id, 'review_comment')) {
        result.push({ sessionId: entry.session.id, row });
      }
    }
    return result;
  }

  async listCommentsByBaselineIds(
    baselineIds: string[],
  ): Promise<SnapshotReviewComment<string>[]> {
    const allowed = new Set(baselineIds);
    if (allowed.size === 0) return [];
    return (await this.#allComments())
      .map(({ row }) => hydrateReviewComment(row))
      .filter((row) => allowed.has(row.baseline_id))
      .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  }

  async listCommentsByIds(ids: string[]): Promise<SnapshotReviewComment<string>[]> {
    const rows = await Promise.all(ids.map((id) => this.getComment(id)));
    return rows.filter((row): row is SnapshotReviewComment<string> => row != null);
  }

  async updateComment(
    id: string,
    patch: Partial<
      Pick<
        SnapshotReviewComment<string>,
        'status' | 'body' | 'severity' | 'suggested_fix'
      >
    > & { operation_id?: string },
  ): Promise<SnapshotReviewComment<string> | null> {
    const located = await this.#locate(id, 'review_comment');
    if (!located) return null;
    const updated = await this.entities.update<StoredReviewComment>(
      located.sessionId,
      'snapshots',
      id,
      (current) => ({
        ...current,
        status: patch.status ?? current.status,
        body: patch.body ?? current.body,
        severity: patch.severity ?? current.severity,
        suggested_fix: patch.suggested_fix ?? current.suggested_fix,
      }),
      {
        operation_id: patch.operation_id,
        operation_key: patch,
      },
    );
    return updated ? hydrateReviewComment(updated) : null;
  }

  async markSent(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map((id) => this.updateComment(id, { status: 'sent' })),
    );
  }

  async getContract(
    sessionKind: string,
    sessionId: SessionId,
    sourceHash: string,
  ): Promise<string | null> {
    const row = (await this.#list(sessionId, 'intent_contract')).find((candidate) => {
      const data = parseIntentContract(candidate.data);
      return (
        data.session_kind === sessionKind &&
        data.session_id === sessionId &&
        data.source_hash === sourceHash
      );
    });
    return row ? parseIntentContract(row.data).obligations_json : null;
  }

  async saveContract(input: {
    session_kind: string;
    session_id: SessionId;
    source_hash: string;
    obligations_json: string;
    provider_id?: string | null;
    model_id?: string | null;
  }): Promise<void> {
    if (await this.getContract(input.session_kind, input.session_id, input.source_hash)) {
      return;
    }
    const data: StoredIntentContract = {
      session_kind: input.session_kind,
      session_id: input.session_id,
      source_hash: input.source_hash,
      obligations_json: input.obligations_json,
      provider_id: input.provider_id ?? null,
      model_id: input.model_id ?? null,
    };
    await this.entities.create(input.session_id, 'snapshots', {
      kind: 'intent_contract',
      data,
      operation_id: `intent-contract:${input.source_hash}`,
      operation_key: { source_hash: input.source_hash },
    });
  }

  async recordFate(input: ReviewFateInput<SessionId, string>): Promise<void> {
    validateSnapshotFilePath(input.file_path);
    const existing = (await this.#list(input.session_id, 'review_fate')).find(
      (candidate) => parseReviewFate(candidate.data).comment_id === input.comment_id,
    );
    const data: StoredReviewFate = {
      ...input,
      observed_at: new Date().toISOString(),
    };
    if (!existing) {
      await this.entities.create(input.session_id, 'snapshots', {
        kind: 'review_fate',
        data,
        operation_id: `review-fate:${input.comment_id}:${input.outcome}`,
        operation_key: input,
      });
      return;
    }
    if (parseReviewFate(existing.data).outcome === input.outcome) return;
    await this.entities.update<StoredReviewFate>(
      input.session_id,
      'snapshots',
      existing.id,
      () => data,
      {
        operation_id: `review-fate:${input.comment_id}:${input.outcome}`,
        operation_key: input,
      },
    );
  }

  async #sessionIdsForProject(projectId?: number): Promise<SessionId[]> {
    await this.directory.ensureCatalog();
    return this.directory.catalog
      .list()
      .filter(
        (entry) =>
          projectId == null ||
          entry.session.owner_project_id === projectId ||
          entry.session.linked_projects.some(
            (project) => Number(project.project_id) === projectId,
          ),
      )
      .map((entry) => entry.session.id);
  }

  async aggregateFates(projectId?: number): Promise<ReviewFateAggregate[]> {
    const counts = new Map<string, ReviewFateAggregate>();
    for (const sessionId of await this.#sessionIdsForProject(projectId)) {
      for (const row of await this.#list(sessionId, 'review_fate')) {
        const fate = parseReviewFate(row.data);
        const key = `${fate.category}\0${fate.severity ?? ''}`;
        const aggregate = counts.get(key) ?? {
          category: fate.category,
          severity: fate.severity,
          accepted: 0,
          dismissed: 0,
          reedited: 0,
          ignored: 0,
          total: 0,
        };
        aggregate[fate.outcome] += 1;
        aggregate.total += 1;
        counts.set(key, aggregate);
      }
    }
    return [...counts.values()];
  }

  async recentDismissals(
    limit = 3,
    projectId?: number,
  ): Promise<RecentDismissal[]> {
    const rows: Array<{ updatedAt: string; value: RecentDismissal }> = [];
    for (const sessionId of await this.#sessionIdsForProject(projectId)) {
      for (const row of await this.#list(sessionId, 'review_comment')) {
        const comment = parseReviewComment(row.data);
        if (comment.status !== 'dismissed') continue;
        rows.push({
          updatedAt: row.updated_at,
          value: {
            body: comment.body,
            file_path: comment.file_path,
            severity: comment.severity,
            kind: comment.kind,
          },
        });
      }
    }
    return rows
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(0, limit))
      .map((row) => row.value);
  }
}
