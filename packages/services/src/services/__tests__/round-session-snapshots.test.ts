import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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
} from '../session-snapshot-port.js';
import { SessionSnapshotService } from '../session-snapshots.js';

const cleanups: Array<() => void> = [];
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

class MemorySnapshotStore
  implements SessionSnapshotStorePort<string, string>
{
  readonly baselines: BaselineRow<string, string>[] = [];
  readonly edits: EditRow<string>[] = [];
  readonly baselineDecisions = new Map<string, HunkDecisionRow<string>[]>();
  readonly rounds: RoundSnapshotRow<string, string>[] = [];
  readonly roundDecisions = new Map<string, RoundHunkDecisionRow<string>[]>();
  private nextSeq = 1;

  private recordId(): string {
    return `00000000-0000-4000-8000-${String(this.nextSeq++).padStart(12, '0')}`;
  }

  recordBaselineAndEdit(
    create: CreateBaselineInput<string>,
    edit: {
      turn_number: number | null;
      tool_name: string;
      content_after_hash: string;
      was_delete: boolean;
    },
  ) {
    const now = new Date().toISOString();
    let baseline = this.baselines.find(
      (row) =>
        row.session_kind === create.session_kind &&
        row.session_id === create.session_id &&
        row.project_id === (create.project_id ?? null) &&
        row.file_path === create.file_path &&
        row.status === 'active',
    );
    const created = !baseline;
    if (!baseline) {
      baseline = {
        id: this.recordId(),
        session_kind: create.session_kind,
        session_id: create.session_id,
        project_id: create.project_id ?? null,
        file_path: create.file_path,
        content_before: create.content_before,
        rollback_content: create.rollback_content ?? create.content_before,
        existed_before: create.existed_before ? 1 : 0,
        baseline_hash: create.baseline_hash,
        oversized: create.oversized ? 1 : 0,
        status: 'active',
        first_seen_at: now,
        last_edited_at: now,
        closed_at: null,
      };
      this.baselines.push(baseline);
    } else {
      baseline.oversized = baseline.oversized || create.oversized ? 1 : 0;
      baseline.last_edited_at = now;
    }
    this.edits.push({
      id: this.recordId(),
      baseline_id: baseline.id,
      turn_number: edit.turn_number,
      tool_name: edit.tool_name,
      content_after_hash: edit.content_after_hash,
      was_delete: edit.was_delete ? 1 : 0,
      applied_at: now,
    });
    return { baseline: { ...baseline }, created };
  }

  getActiveBaseline(
    kind: SessionKind,
    sessionId: string,
    filePath: string,
    projectId: number | null = null,
  ) {
    return this.baselines.find(
      (row) =>
        row.session_kind === kind &&
        row.session_id === sessionId &&
        row.file_path === filePath &&
        row.project_id === projectId &&
        row.status === 'active',
    ) ?? null;
  }

  getBaselineById(id: string) {
    return this.baselines.find((row) => row.id === id) ?? null;
  }

  listBaselines(
    kind: SessionKind,
    sessionId: string,
    opts: { includeClosed?: boolean } = {},
  ) {
    return this.baselines.filter(
      (row) =>
        row.session_kind === kind &&
        row.session_id === sessionId &&
        (opts.includeClosed || row.status === 'active'),
    );
  }

  listEdits(id: string) {
    return this.edits.filter((row) => row.baseline_id === id);
  }

  listHunkDecisions(id: string) {
    return this.baselineDecisions.get(id) ?? [];
  }

  recordRoundSnapshotMutation(
    input: RecordRoundSnapshotMutationInput<string, string>,
  ) {
    const now = new Date().toISOString();
    let row = this.rounds.find(
      (candidate) =>
        candidate.session_kind === input.session_kind &&
        candidate.session_id === input.session_id &&
        candidate.round_message_id === input.round_message_id &&
        candidate.project_id === (input.project_id ?? null) &&
        candidate.file_path === input.file_path,
    );
    if (!row) {
      row = {
        id: this.recordId(),
        session_kind: input.session_kind,
        session_id: input.session_id,
        round_message_id: input.round_message_id,
        global_baseline_id: input.global_baseline_id,
        project_id: input.project_id ?? null,
        file_path: input.file_path,
        content_before: input.content_before,
        existed_before: input.existed_before ? 1 : 0,
        content_after: input.content_after,
        existed_after: input.existed_after ? 1 : 0,
        oversized: input.oversized ? 1 : 0,
        status: 'active',
        first_seen_at: now,
        last_edited_at: now,
        closed_at: null,
      };
      this.rounds.push(row);
    } else {
      row.content_after = input.content_after;
      row.existed_after = input.existed_after ? 1 : 0;
      row.oversized = row.oversized || input.oversized ? 1 : 0;
      row.last_edited_at = now;
    }
    return { ...row };
  }

  getRoundSnapshotById(id: string) {
    return this.rounds.find((row) => row.id === id) ?? null;
  }

  listRoundSnapshots(
    kind: SessionKind,
    sessionId: string,
    roundMessageId: number,
    opts: { includeClosed?: boolean } = {},
  ) {
    return this.rounds.filter(
      (row) =>
        row.session_kind === kind &&
        row.session_id === sessionId &&
        row.round_message_id === roundMessageId &&
        (opts.includeClosed || row.status === 'active'),
    );
  }

  listRoundHunkDecisions(id: string) {
    return this.roundDecisions.get(id) ?? [];
  }

  upsertRoundHunkDecision(
    id: string,
    fingerprint: string,
    decision: HunkDecision,
  ) {
    const rows = this.roundDecisions.get(id) ?? [];
    const existing = rows.find(
      (row) => row.hunk_fingerprint === fingerprint,
    );
    if (existing) existing.decision = decision;
    else {
      rows.push({
        id: this.recordId(),
        round_snapshot_id: id,
        hunk_fingerprint: fingerprint,
        decision,
        decided_at: new Date().toISOString(),
      });
    }
    this.roundDecisions.set(id, rows);
  }

  closeRoundSnapshot(
    id: string,
    status: 'closed_kept' | 'closed_reverted',
  ) {
    const row = this.getRoundSnapshotById(id);
    if (row) {
      row.status = status;
      row.closed_at = new Date().toISOString();
    }
  }

  listRoundReviewFindings(): RoundReviewFindingRow<string>[] {
    return [];
  }

  replaceRoundReviewFindings(
    _ids: string[],
    _findings: CreateRoundReviewFindingInput<string>[],
  ): RoundReviewFindingRow<string>[] {
    return [];
  }

  upsertHunkDecision(
    id: string,
    fingerprint: string,
    decision: HunkDecision,
  ) {
    const rows = this.baselineDecisions.get(id) ?? [];
    const existing = rows.find(
      (row) => row.hunk_fingerprint === fingerprint,
    );
    if (existing) existing.decision = decision;
    else {
      rows.push({
        id: this.recordId(),
        baseline_id: id,
        hunk_fingerprint: fingerprint,
        decision,
        decided_at: new Date().toISOString(),
      });
    }
    this.baselineDecisions.set(id, rows);
  }

  closeBaseline(
    id: string,
    status: 'closed_kept' | 'closed_reverted',
  ) {
    const row = this.getBaselineById(id);
    if (row) {
      row.status = status;
      row.closed_at = new Date().toISOString();
    }
  }

  markBaselineReverted(id: string) {
    this.closeBaseline(id, 'closed_reverted');
  }

  listActiveBaselineIds(kind: SessionKind, sessionId: string) {
    return this.listBaselines(kind, sessionId).map((row) => row.id);
  }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'round-snapshot-'));
  const store = new MemorySnapshotStore();
  const service = new SessionSnapshotService(store, () => root);
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, service };
}

function globalBaseline(
  store: MemorySnapshotStore,
  filePath: string,
  content: string,
  oversized = false,
) {
  return store.recordBaselineAndEdit({
    session_kind: 'coder',
    session_id: SESSION_ID,
    project_id: 10,
    file_path: filePath,
    content_before: oversized ? null : content,
    rollback_content: content,
    existed_before: true,
    baseline_hash: 'before',
    oversized,
  }, {
    turn_number: 1,
    tool_name: 'edit_file',
    content_after_hash: 'after',
    was_delete: false,
  }).baseline;
}

describe('per-round session snapshots', () => {
  it('consolidates multiple writes in the same round into one frozen envelope', () => {
    const { store } = harness();
    const baseline = globalBaseline(store, 'src/a.ts', 'before\n');
    const input = {
      session_kind: 'coder' as const,
      session_id: SESSION_ID,
      round_message_id: 100,
      global_baseline_id: baseline.id,
      project_id: 10,
      file_path: 'src/a.ts',
      existed_before: true,
      existed_after: true,
      oversized: false,
    };

    const first = store.recordRoundSnapshotMutation({
      ...input,
      content_before: 'before\n',
      content_after: 'intermediate\n',
    });
    const last = store.recordRoundSnapshotMutation({
      ...input,
      content_before: 'intermediate\n',
      content_after: 'after\n',
    });

    expect(last.id).toBe(first.id);
    expect(store.listRoundSnapshots('coder', SESSION_ID, 100, { includeClosed: true }))
      .toEqual([expect.objectContaining({
        content_before: 'before\n',
        content_after: 'after\n',
      })]);
  });

  it('freezes each round while the global diff remains cumulative', async () => {
    const { root, store, service } = harness();
    const original = 'const a = 1;\n';
    const roundOneAfter = 'const a = 2;\n';
    const roundTwoAfter = 'const a = 2;\nconst b = 3;\n';
    const baseline = globalBaseline(store, 'src/a.ts', original);

    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: SESSION_ID, round_message_id: 100,
      global_baseline_id: baseline.id, project_id: 10, file_path: 'src/a.ts',
      content_before: original, existed_before: true,
      content_after: roundOneAfter, existed_after: true, oversized: false,
    });
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: SESSION_ID, round_message_id: 200,
      global_baseline_id: baseline.id, project_id: 10, file_path: 'src/a.ts',
      content_before: roundOneAfter, existed_before: true,
      content_after: roundTwoAfter, existed_after: true, oversized: false,
    });
    const abs = join(root, 'src', 'a.ts');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(abs, roundTwoAfter);

    const first = await service.listRoundFiles('coder', SESSION_ID, 100);
    const second = await service.listRoundFiles('coder', SESSION_ID, 200);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ addedLines: 1, removedLines: 1, globalBaselineId: baseline.id });
    expect(second[0]).toMatchObject({ addedLines: 1, removedLines: 0 });

    const firstDiff = await service.getRoundDiff(first[0].roundSnapshotId);
    expect(firstDiff?.hunks.flatMap((hunk) => hunk.lines).map((line) => line.content))
      .toContain('const a = 2;');
    expect(firstDiff?.hunks.flatMap((hunk) => hunk.lines).map((line) => line.content))
      .not.toContain('const b = 3;');

    const fingerprint = firstDiff?.hunks[0]?.fingerprint;
    expect(fingerprint).toBeTruthy();
    expect(await service.acceptRoundHunk(first[0].roundSnapshotId, fingerprint!))
      .toEqual({ ok: true, closed: true });
    expect((await service.listRoundFiles('coder', SESSION_ID, 100))[0]).toMatchObject({
      addedLines: 1,
      removedLines: 1,
      pendingHunks: 0,
      status: 'closed_kept',
    });
    expect(store.getBaselineById(baseline.id)?.status).toBe('active');

    const global = await service.getDiff(baseline.id);
    expect(global?.hunks.reduce((sum, hunk) => sum + hunk.addedCount, 0)).toBe(2);
  });

  it('reverts a shifted non-overlapping round and keeps the global original available', async () => {
    const { root, store, service } = harness();
    const original = 'a\nb\nc\n';
    const roundAfter = 'a\nB\nc\n';
    const current = 'A-later\nB\nc\nfooter\n';
    const baseline = globalBaseline(store, 'file.ts', original);
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: SESSION_ID, round_message_id: 100,
      global_baseline_id: baseline.id, project_id: 10, file_path: 'file.ts',
      content_before: original, existed_before: true,
      content_after: roundAfter, existed_after: true, oversized: false,
    });
    writeFileSync(join(root, 'file.ts'), current);

    const roundResult = await service.revertRoundAll('coder', SESSION_ID, 100);
    expect(roundResult).toMatchObject({ ok: true, reverted: 1, conflicts: [] });
    expect(readFileSync(join(root, 'file.ts'), 'utf8')).toBe('A-later\nb\nc\nfooter\n');
    expect(store.getBaselineById(baseline.id)?.status).toBe('active');

    expect(await service.revertFile(baseline.id)).toEqual({ ok: true });
    expect(readFileSync(join(root, 'file.ts'), 'utf8')).toBe(original);
  });

  it('preflights conflicts without partially reverting other files', async () => {
    const { root, store, service } = harness();
    const aBaseline = globalBaseline(store, 'a.ts', 'a\n');
    const bBaseline = globalBaseline(store, 'b.ts', 'b\n');
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: SESSION_ID, round_message_id: 100,
      global_baseline_id: aBaseline.id, project_id: 10, file_path: 'a.ts',
      content_before: 'a\n', existed_before: true,
      content_after: 'A\n', existed_after: true, oversized: false,
    });
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: SESSION_ID, round_message_id: 100,
      global_baseline_id: bBaseline.id, project_id: 10, file_path: 'b.ts',
      content_before: 'b\n', existed_before: true,
      content_after: 'B\n', existed_after: true, oversized: false,
    });
    writeFileSync(join(root, 'a.ts'), 'A\n');
    writeFileSync(join(root, 'b.ts'), 'later-overlap\n');

    const result = await service.revertRoundAll('coder', SESSION_ID, 100);
    expect(result.ok).toBe(false);
    expect(result.reverted).toBe(0);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(root, 'b.ts'), 'utf8')).toBe('later-overlap\n');
  });

  it('restores a round deletion beside a later non-overlapping edit', async () => {
    const { root, store, service } = harness();
    const baseline = globalBaseline(store, 'deleted-line.ts', 'a\nremove me\nc\n');
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: SESSION_ID, round_message_id: 100,
      global_baseline_id: baseline.id, project_id: 10, file_path: 'deleted-line.ts',
      content_before: 'a\nremove me\nc\n', existed_before: true,
      content_after: 'a\nc\n', existed_after: true, oversized: false,
    });
    writeFileSync(join(root, 'deleted-line.ts'), 'A-later\nc\nfooter\n');

    expect(await service.revertRoundAll('coder', SESSION_ID, 100))
      .toMatchObject({ ok: true, reverted: 1 });
    expect(readFileSync(join(root, 'deleted-line.ts'), 'utf8'))
      .toBe('A-later\nremove me\nc\nfooter\n');
  });

  it('rolls back both the creation and deletion sides of a rename', async () => {
    const { root, store, service } = harness();
    const oldBaseline = globalBaseline(store, 'old.ts', 'content\n');
    const newBaseline = store.recordBaselineAndEdit({
      session_kind: 'coder', session_id: SESSION_ID, project_id: 10, file_path: 'new.ts',
      content_before: null, rollback_content: null, existed_before: false,
      baseline_hash: '', oversized: false,
    }, {
      turn_number: 1, tool_name: 'rename', content_after_hash: 'content', was_delete: false,
    }).baseline;
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: SESSION_ID, round_message_id: 100,
      global_baseline_id: oldBaseline.id, project_id: 10, file_path: 'old.ts',
      content_before: 'content\n', existed_before: true,
      content_after: null, existed_after: false, oversized: false,
    });
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: SESSION_ID, round_message_id: 100,
      global_baseline_id: newBaseline.id, project_id: 10, file_path: 'new.ts',
      content_before: null, existed_before: false,
      content_after: 'content\n', existed_after: true, oversized: false,
    });
    writeFileSync(join(root, 'new.ts'), 'content\n');

    expect(await service.revertRoundAll('coder', SESSION_ID, 100))
      .toMatchObject({ ok: true, reverted: 2 });
    expect(readFileSync(join(root, 'old.ts'), 'utf8')).toBe('content\n');
    expect(() => readFileSync(join(root, 'new.ts'), 'utf8')).toThrow();
  });

  it('restores an oversized global baseline from the rollback payload', async () => {
    const { root, store, service } = harness();
    const original = 'large original\n';
    const baseline = globalBaseline(store, 'large.ts', original, true);
    writeFileSync(join(root, 'large.ts'), 'changed\n');
    expect(await service.revertFile(baseline.id)).toEqual({ ok: true });
    expect(readFileSync(join(root, 'large.ts'), 'utf8')).toBe(original);
  });

  it('reopens an approved global baseline from history and restores its original', async () => {
    const { root, store, service } = harness();
    const baseline = globalBaseline(store, 'approved.ts', 'original\n');
    writeFileSync(join(root, 'approved.ts'), 'kept change\n');

    expect(await service.acceptFile(baseline.id)).toEqual({ ok: true });
    expect(store.getBaselineById(baseline.id)?.status).toBe('closed_kept');
    expect(await service.revertFile(baseline.id)).toEqual({ ok: true });

    expect(readFileSync(join(root, 'approved.ts'), 'utf8')).toBe('original\n');
    expect(store.getBaselineById(baseline.id)?.status).toBe('closed_reverted');
  });

  it('retains the original rollback payload when a later write makes the active baseline large', () => {
    const { store } = harness();
    const baseline = globalBaseline(store, 'large-later.ts', 'original\n');

    const updated = store.recordBaselineAndEdit({
      session_kind: 'coder',
      session_id: SESSION_ID,
      project_id: 10,
      file_path: 'large-later.ts',
      content_before: 'not a new baseline\n',
      rollback_content: 'not a new baseline\n',
      existed_before: true,
      baseline_hash: 'later',
      oversized: true,
    }, {
      turn_number: 2,
      tool_name: 'edit_file',
      content_after_hash: 'large',
      was_delete: false,
    }).baseline;

    expect(updated.id).toBe(baseline.id);
    expect(updated.oversized).toBe(1);
    expect(updated.rollback_content).toBe('original\n');
  });
});
