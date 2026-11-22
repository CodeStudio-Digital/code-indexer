import {
  isUuid,
  newSessionId,
  type ArtifactRef,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import type {
  CreateRoundReviewFindingInput,
  HunkDecision,
  RecordRoundSnapshotMutationInput,
  RoundHunkDecisionRow,
  RoundReviewFindingRow,
  RoundSnapshotRow,
  SessionKind,
} from '../contracts/session-snapshot-port.js';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import { FsSessionDirectory } from './session-directory.js';
import {
  decisionRows,
  parseRound,
  parseRoundReview,
  roundRow,
  validateSnapshotFilePath,
  type StoredDecision,
  type StoredRoundReview,
  type StoredRoundReviewFinding,
  type StoredRoundSnapshot,
} from './snapshot-files-codec.js';

type Entity = FsEntityEnvelope<JsonValue>;
type Round = RoundSnapshotRow<SessionId, string>;

function sameProject(left: number | null, right: number | null): boolean {
  return left === right;
}

function nextSeq(rows: readonly { seq: number }[]): number {
  return Math.max(0, ...rows.map((row) => row.seq)) + 1;
}

/**
 * Round-scoped snapshots are isolated from the mutable session baseline
 * implementation so both repositories remain small and independently
 * recoverable. The public FsSessionSnapshotRepository delegates this surface.
 */
export class FsRoundSnapshotRepository {
  readonly #recordOwners = new Map<string, SessionId>();

  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {}

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

  async #list(sessionId: SessionId, kind?: string, roundMessageId?: number): Promise<Entity[]> {
    const records = await this.entities.list<JsonValue>(
      sessionId,
      'snapshots',
      kind,
      false,
      roundMessageId,
    );
    for (const record of records) this.#recordOwners.set(record.id, sessionId);
    return records;
  }

  async #locate(
    id: string,
    kind: string,
  ): Promise<{ sessionId: SessionId; record: Entity } | null> {
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

  async #row(sessionId: SessionId, record: Entity): Promise<Round> {
    const entry = await this.directory.requireEntry(sessionId);
    const artifacts = this.directory.repository.artifactReader(
      entry.location,
    );
    return roundRow(record, artifacts);
  }

  async recordRoundSnapshotMutation(
    input: RecordRoundSnapshotMutationInput<SessionId, string>,
  ): Promise<Round> {
    const sessionId = input.session_id;
    validateSnapshotFilePath(input.file_path);
    const operationId = input.operation_id ?? `round-snapshot:${newSessionId()}`;
    const [before, after] = await Promise.all([
      this.#putContent(sessionId, input.content_before, `${input.file_path}.round-before`),
      this.#putContent(sessionId, input.content_after, `${input.file_path}.round-after`),
    ]);
    return this.directory.runMutation(sessionId, async () => {
      const records = await this.#list(sessionId, 'round_snapshot');
      const existing = records.find((candidate) => {
        const data = parseRound(candidate.data);
        return (
          data.session_kind === input.session_kind &&
          data.session_id === sessionId &&
          data.round_message_seq === input.round_message_id &&
          data.file_path === input.file_path &&
          sameProject(data.project_id, input.project_id ?? null)
        );
      });
      const now = new Date().toISOString();
      let record: Entity;
      if (existing) {
        record = (await this.entities.updateWithinMutation<StoredRoundSnapshot>(
          sessionId,
          'snapshots',
          existing.id,
          (current) => ({
            ...current,
            content_after: after,
            existed_after: input.existed_after,
            oversized: current.oversized || input.oversized,
            global_baseline_id: input.global_baseline_id,
            status: 'active',
            closed_at: null,
            last_edited_at: now,
          }),
          {
            operation_id: operationId,
            operation_key: input,
          },
        ))!;
      } else {
        const data: StoredRoundSnapshot = {
          session_kind: input.session_kind,
          session_id: sessionId,
          round_message_seq: input.round_message_id,
          global_baseline_id: input.global_baseline_id,
          project_id: input.project_id ?? null,
          file_path: input.file_path,
          content_before: before,
          existed_before: input.existed_before,
          content_after: after,
          existed_after: input.existed_after,
          oversized: input.oversized,
          status: 'active',
          first_seen_at: now,
          last_edited_at: now,
          closed_at: null,
          decisions: [],
        };
        record = await this.entities.createWithinMutation(
          sessionId,
          'snapshots',
          {
            kind: 'round_snapshot',
            data,
            operation_id: operationId,
            operation_key: input,
          },
        );
      }
      this.#recordOwners.set(record.id, sessionId);
      return this.#row(sessionId, record);
    });
  }

  async getRoundSnapshotById(id: string): Promise<Round | null> {
    const located = await this.#locate(id, 'round_snapshot');
    return located ? this.#row(located.sessionId, located.record) : null;
  }

  async listRoundSnapshots(
    kind: SessionKind,
    sessionId: SessionId,
    roundMessageId: number,
    opts: { includeClosed?: boolean } = {},
  ): Promise<Round[]> {
    const records = (await this.#list(sessionId, 'round_snapshot', roundMessageId)).filter((record) => {
      const data = parseRound(record.data);
      return (
        data.session_kind === kind &&
        data.session_id === sessionId &&
        data.round_message_seq === roundMessageId &&
        (opts.includeClosed || data.status === 'active')
      );
    });
    const rows: Round[] = [];
    for (let offset = 0; offset < records.length; offset += 8) {
      rows.push(...await Promise.all(
        records.slice(offset, offset + 8).map((record) =>
          this.#row(sessionId, record)),
      ));
    }
    return rows;
  }

  async listRoundHunkDecisions(
    roundSnapshotId: string,
  ): Promise<RoundHunkDecisionRow<string>[]> {
    const located = await this.#locate(roundSnapshotId, 'round_snapshot');
    if (!located) return [];
    return decisionRows(
      roundSnapshotId,
      parseRound(located.record.data).decisions,
      true,
    ) as RoundHunkDecisionRow<string>[];
  }

  async upsertRoundHunkDecision(
    roundSnapshotId: string,
    fingerprint: string,
    verdict: HunkDecision,
  ): Promise<void> {
    const located = await this.#locate(roundSnapshotId, 'round_snapshot');
    if (!located) return;
    await this.entities.update<StoredRoundSnapshot>(
      located.sessionId,
      'snapshots',
      roundSnapshotId,
      (current) => {
        const existing = current.decisions.find(
          (row) => row.hunk_fingerprint === fingerprint,
        );
        if (existing?.decision === verdict) return current;
        const now = new Date().toISOString();
        const next: StoredDecision = existing
          ? { ...existing, decision: verdict, decided_at: now }
          : {
              id: newSessionId(),
              seq: nextSeq(current.decisions),
              hunk_fingerprint: fingerprint,
              decision: verdict,
              decided_at: now,
            };
        return {
          ...current,
          decisions: existing
            ? current.decisions.map((row) => (row.id === existing.id ? next : row))
            : [...current.decisions, next],
        };
      },
    );
  }

  async closeRoundSnapshot(
    id: string,
    status: 'closed_kept' | 'closed_reverted',
  ): Promise<void> {
    const located = await this.#locate(id, 'round_snapshot');
    if (!located) return;
    await this.entities.update<StoredRoundSnapshot>(
      located.sessionId,
      'snapshots',
      id,
      (current) =>
        current.status !== 'active'
          ? current
          : {
              ...current,
              status,
              closed_at: new Date().toISOString(),
            },
    );
  }

  async replaceRoundReviewFindings(
    roundSnapshotIds: string[],
    findings: CreateRoundReviewFindingInput<string>[],
  ): Promise<RoundReviewFindingRow<string>[]> {
    if (roundSnapshotIds.length === 0) return [];
    const located = await Promise.all(
      roundSnapshotIds.map((id) => this.#locate(id, 'round_snapshot')),
    );
    if (located.some((row) => !row)) throw new Error('Unknown round snapshot');
    const sessionId = located[0]!.sessionId;
    if (located.some((row) => row!.sessionId !== sessionId)) {
      throw new Error('Round review cannot cross session bundles');
    }
    const now = new Date().toISOString();
    const rows: StoredRoundReviewFinding[] = findings.map((finding, index) => {
      if (!roundSnapshotIds.includes(finding.round_snapshot_id)) {
        throw new Error('Round review finding targets a different review set');
      }
      return {
        id: newSessionId(),
        seq: index + 1,
        round_snapshot_id: finding.round_snapshot_id,
        hunk_fingerprint: finding.hunk_fingerprint ?? null,
        old_line: finding.old_line ?? null,
        new_line: finding.new_line ?? null,
        severity: finding.severity ?? null,
        body: finding.body,
        suggested_fix: finding.suggested_fix ?? null,
        diff_excerpt: finding.diff_excerpt ?? null,
        created_at: now,
      };
    });
    const data: StoredRoundReview = {
      session_id: sessionId,
      round_snapshot_ids: [...roundSnapshotIds],
      findings: rows,
    };
    const record = await this.entities.create(sessionId, 'snapshots', {
      kind: 'round_review',
      data,
      operation_id:
        findings.find((finding) => finding.operation_id)?.operation_id ??
        `round-review:${newSessionId()}`,
      operation_key: { roundSnapshotIds, findings },
    });
    return parseRoundReview(record.data).findings.map(
      (finding) => ({ ...finding }),
    );
  }

  async listRoundReviewFindings(
    kind: SessionKind,
    sessionId: SessionId,
    roundMessageId: number,
    knownRows?: readonly Round[],
  ): Promise<RoundReviewFindingRow<string>[]> {
    const roundIds = new Set(
      (knownRows ?? await this.listRoundSnapshots(kind, sessionId, roundMessageId, {
        includeClosed: true,
      })).filter(row => row.session_kind === kind && row.session_id === sessionId && row.round_message_id === roundMessageId).map(row => row.id),
    );
    if (roundIds.size === 0) return [];
    const reviews = (await this.#list(sessionId, 'round_review'))
      .map((record) => ({
        record,
        data: parseRoundReview(record.data),
      }))
      .filter(({ data }) =>
        Array.isArray(data.round_snapshot_ids) &&
        data.round_snapshot_ids.some((id) => roundIds.has(id)),
      )
      .sort((left, right) => right.record.seq - left.record.seq);
    const latest = reviews[0]?.data;
    if (!latest) return [];
    return latest.findings
      .filter((finding) => roundIds.has(finding.round_snapshot_id))
      .map((finding) => ({ ...finding }));
  }
}
