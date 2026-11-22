import {
  isUuid,
  newSessionId,
  type ArtifactRef,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import type {
  BaselineRow,
  CreateBaselineInput,
  CreateRoundReviewFindingInput,
  EditRow,
  HunkDecision,
  HunkDecisionRow,
  RecordRoundSnapshotMutationInput,
  RoundHunkDecisionRow,
  RoundReviewFindingRow,
  RoundSnapshotRow,
  SessionKind,
  SessionSnapshotStorePort,
} from '../contracts/session-snapshot-port.js';
import { toJsonValue } from './conversation-codec.js';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import { FsSessionDirectory } from './session-directory.js';
import {
  baselineRow,
  decisionRows,
  editRows,
  parseBaseline,
  validateSnapshotFilePath,
  type StoredBaseline,
  type StoredDecision,
  type StoredEdit,
} from './snapshot-files-codec.js';
import { FsRoundSnapshotRepository } from './round-snapshot-repository.js';

type Entity = FsEntityEnvelope<JsonValue>;
type Baseline = BaselineRow<SessionId, string>;

function sameProject(left: number | null, right: number | null): boolean {
  return left === right;
}

function nextSeq(rows: readonly { seq: number }[]): number {
  return Math.max(0, ...rows.map((row) => row.seq)) + 1;
}

export class FsSessionSnapshotRepository
  implements SessionSnapshotStorePort<SessionId, string>
{
  readonly #recordOwners = new Map<string, SessionId>();
  readonly #rounds: FsRoundSnapshotRepository;

  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {
    this.#rounds = new FsRoundSnapshotRepository(directory, entities);
  }

  async #putContent(
    sessionId: SessionId,
    content: string | null | undefined,
    logicalName: string,
  ): Promise<ArtifactRef | null> {
    if (content == null) return null;
    const entry = await this.directory.requireEntry(sessionId);
    const artifacts = await this.directory.repository.artifactStore(
      entry.location,
    );
    return artifacts.put({
      kind: 'snapshot_blob',
      data: content,
      media_type: 'text/plain; charset=utf-8',
      logical_name: logicalName,
    });
  }

  async #list(sessionId: SessionId, kind?: string): Promise<Entity[]> {
    const records = await this.entities.list<JsonValue>(
      sessionId,
      'snapshots',
      kind,
    );
    for (const record of records) this.#recordOwners.set(record.id, sessionId);
    return records;
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
      if (found) throw new Error(`Duplicate snapshot UUID ${id}`);
      found = { sessionId: entry.session.id, record };
    }
    if (found) this.#recordOwners.set(id, found.sessionId);
    return found;
  }

  async sessionIdForBaseline(id: string): Promise<SessionId | null> {
    return (await this.#locate(id, 'file_baseline'))?.sessionId ?? null;
  }

  async getActiveBaseline(
    kind: SessionKind,
    sessionId: SessionId,
    filePath: string,
    projectId: number | null = null,
  ): Promise<Baseline | null> {
    const record = (await this.#list(sessionId, 'file_baseline')).find((candidate) => {
      const data = parseBaseline(candidate.data);
      return (
        data.session_kind === kind &&
        data.session_id === sessionId &&
        data.file_path === filePath &&
        sameProject(data.project_id, projectId) &&
        data.status === 'active'
      );
    });
    return record ? this.#baselineRow(sessionId, record) : null;
  }

  async getBaselineById(id: string): Promise<Baseline | null> {
    const located = await this.#locate(id, 'file_baseline');
    return located ? this.#baselineRow(located.sessionId, located.record) : null;
  }

  /** Scope checks need the original session, project and path, without reading artifact contents. */
  async baselineIdentities(sessionId: SessionId, ids: readonly string[]) {
    const result = new Map<string, Pick<StoredBaseline, 'session_kind' | 'session_id' | 'project_id' | 'file_path'>>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 16) {
      await Promise.all(unique.slice(i, i + 16).map(async id => {
        const record = await this.entities.get(sessionId, 'snapshots', id);
        if (record?.kind !== 'file_baseline') return;
        const { session_kind, session_id, project_id, file_path } = parseBaseline(record.data);
        result.set(id, { session_kind, session_id, project_id, file_path });
      }));
    }
    return result;
  }

  async #baselineRow(sessionId: SessionId, record: Entity): Promise<Baseline> {
    const entry = await this.directory.requireEntry(sessionId);
    const artifacts = this.directory.repository.artifactReader(
      entry.location,
    );
    return baselineRow(
      record,
      artifacts,
    );
  }

  async recordBaselineAndEdit(
    create: CreateBaselineInput<SessionId>,
    edit: {
      turn_number: number | null;
      tool_name: string;
      content_after_hash: string;
      was_delete: boolean;
      operation_id?: string;
    },
  ): Promise<{ baseline: Baseline; created: boolean }> {
    const sessionId = create.session_id;
    validateSnapshotFilePath(create.file_path);
    const operationId =
      edit.operation_id ?? create.operation_id ?? `snapshot-edit:${newSessionId()}`;
    const [before, rollback] = await Promise.all([
      this.#putContent(sessionId, create.content_before, `${create.file_path}.baseline`),
      this.#putContent(
        sessionId,
        create.rollback_content ?? create.content_before,
        `${create.file_path}.rollback`,
      ),
    ]);
    return this.directory.runMutation(sessionId, async () => {
      const candidates = await this.#list(sessionId, 'file_baseline');
      const existing = candidates.find((candidate) => {
        const data = parseBaseline(candidate.data);
        return (
          data.session_kind === create.session_kind &&
          data.session_id === sessionId &&
          data.file_path === create.file_path &&
          sameProject(data.project_id, create.project_id ?? null) &&
          data.status === 'active'
        );
      });
      const now = new Date().toISOString();
      const makeEdit = (rows: readonly StoredEdit[]): StoredEdit => ({
        id: newSessionId(),
        seq: nextSeq(rows),
        turn_number: edit.turn_number,
        tool_name: edit.tool_name,
        content_after_hash: edit.content_after_hash,
        was_delete: edit.was_delete,
        applied_at: now,
      });
      let record: Entity;
      let created = false;
      if (existing) {
        record = (await this.entities.updateWithinMutation<StoredBaseline>(
          sessionId,
          'snapshots',
          existing.id,
          (current) => ({
            ...current,
            oversized: current.oversized || create.oversized,
            last_edited_at: now,
            edits: [...current.edits, makeEdit(current.edits)],
          }),
          {
            operation_id: operationId,
            operation_key: { create, edit },
          },
        ))!;
      } else {
        const firstEdit = makeEdit([]);
        const data: StoredBaseline = {
          session_kind: create.session_kind,
          session_id: sessionId,
          project_id: create.project_id ?? null,
          file_path: create.file_path,
          content_before: before,
          rollback_content: rollback,
          existed_before: create.existed_before,
          baseline_hash: create.baseline_hash,
          oversized: create.oversized,
          status: 'active',
          first_seen_at: now,
          last_edited_at: now,
          closed_at: null,
          edits: [firstEdit],
          decisions: [],
        };
        record = await this.entities.createWithinMutation(
          sessionId,
          'snapshots',
          {
            kind: 'file_baseline',
            data,
            operation_id: operationId,
            operation_key: { create, edit },
          },
        );
        created = true;
      }
      this.#recordOwners.set(record.id, sessionId);
      return { baseline: await this.#baselineRow(sessionId, record), created };
    });
  }

  async listBaselines(
    kind: SessionKind,
    sessionId: SessionId,
    opts: { includeClosed?: boolean } = {},
  ): Promise<Baseline[]> {
    const records = (await this.#list(sessionId, 'file_baseline')).filter((record) => {
      const data = parseBaseline(record.data);
      return (
        data.session_kind === kind &&
        data.session_id === sessionId &&
        (opts.includeClosed || data.status === 'active')
      );
    });
    const rows: Baseline[] = [];
    for (let offset = 0; offset < records.length; offset += 8) {
      rows.push(...await Promise.all(
        records.slice(offset, offset + 8).map((record) =>
          this.#baselineRow(sessionId, record)),
      ));
    }
    return rows;
  }

  async listEdits(baselineId: string): Promise<EditRow<string>[]> {
    const located = await this.#locate(baselineId, 'file_baseline');
    return located ? editRows(baselineId, parseBaseline(located.record.data)) : [];
  }

  async listHunkDecisions(baselineId: string): Promise<HunkDecisionRow<string>[]> {
    const located = await this.#locate(baselineId, 'file_baseline');
    if (!located) return [];
    return decisionRows(
      baselineId,
      parseBaseline(located.record.data).decisions,
    ) as HunkDecisionRow<string>[];
  }

  async #upsertDecision(
    id: string,
    fingerprint: string,
    verdict: HunkDecision,
  ): Promise<void> {
    const located = await this.#locate(id, 'file_baseline');
    if (!located) return;
    await this.entities.update<StoredBaseline>(
      located.sessionId,
      'snapshots',
      id,
      (current) => {
        const rows = current.decisions;
        const existing = rows.find((row) => row.hunk_fingerprint === fingerprint);
        if (existing?.decision === verdict) return current;
        const now = new Date().toISOString();
        const next: StoredDecision = existing
          ? { ...existing, decision: verdict, decided_at: now }
          : {
              id: newSessionId(),
              seq: nextSeq(rows),
              hunk_fingerprint: fingerprint,
              decision: verdict,
              decided_at: now,
            };
        return {
          ...current,
          decisions: existing
            ? rows.map((row) => (row.id === existing.id ? next : row))
            : [...rows, next],
        };
      },
    );
  }

  upsertHunkDecision(
    baselineId: string,
    fingerprint: string,
    decision: HunkDecision,
  ): Promise<void> {
    return this.#upsertDecision(baselineId, fingerprint, decision);
  }

  async #close(
    id: string,
    nextStatus: 'closed_kept' | 'closed_reverted',
    force = false,
  ): Promise<void> {
    const located = await this.#locate(id, 'file_baseline');
    if (!located) return;
    await this.entities.update<StoredBaseline>(
      located.sessionId,
      'snapshots',
      id,
      (current) =>
        !force && current.status !== 'active'
          ? current
          : {
              ...current,
              status: nextStatus,
              closed_at: new Date().toISOString(),
            },
    );
  }

  closeBaseline(
    baselineId: string,
    status: 'closed_kept' | 'closed_reverted',
  ): Promise<void> {
    return this.#close(baselineId, status);
  }

  markBaselineReverted(baselineId: string): Promise<void> {
    return this.#close(
      baselineId,
      'closed_reverted',
      true,
    );
  }

  async listActiveBaselineIds(
    kind: SessionKind,
    sessionId: SessionId,
  ): Promise<string[]> {
    return (await this.listBaselines(kind, sessionId)).map((row) => row.id);
  }

  recordRoundSnapshotMutation(
    input: RecordRoundSnapshotMutationInput<SessionId, string>,
  ): Promise<RoundSnapshotRow<SessionId, string>> {
    return this.#rounds.recordRoundSnapshotMutation(input);
  }

  getRoundSnapshotById(
    id: string,
  ): Promise<RoundSnapshotRow<SessionId, string> | null> {
    return this.#rounds.getRoundSnapshotById(id);
  }

  listRoundSnapshots(
    kind: SessionKind,
    sessionId: SessionId,
    roundMessageId: number,
    opts: { includeClosed?: boolean } = {},
  ): Promise<RoundSnapshotRow<SessionId, string>[]> {
    return this.#rounds.listRoundSnapshots(kind, sessionId, roundMessageId, opts);
  }

  listRoundHunkDecisions(
    id: string,
  ): Promise<RoundHunkDecisionRow<string>[]> {
    return this.#rounds.listRoundHunkDecisions(id);
  }

  upsertRoundHunkDecision(
    id: string,
    fingerprint: string,
    decision: HunkDecision,
  ): Promise<void> {
    return this.#rounds.upsertRoundHunkDecision(id, fingerprint, decision);
  }

  closeRoundSnapshot(
    id: string,
    status: 'closed_kept' | 'closed_reverted',
  ): Promise<void> {
    return this.#rounds.closeRoundSnapshot(id, status);
  }

  replaceRoundReviewFindings(
    roundSnapshotIds: string[],
    findings: CreateRoundReviewFindingInput<string>[],
  ): Promise<RoundReviewFindingRow<string>[]> {
    return this.#rounds.replaceRoundReviewFindings(
      roundSnapshotIds,
      findings,
    );
  }

  listRoundReviewFindings(
    kind: SessionKind,
    sessionId: SessionId,
    roundMessageId: number,
    knownRows?: readonly RoundSnapshotRow<SessionId, string>[],
  ): Promise<RoundReviewFindingRow<string>[]> {
    return this.#rounds.listRoundReviewFindings(
      kind,
      sessionId,
      roundMessageId,
      knownRows,
    );
  }
}
