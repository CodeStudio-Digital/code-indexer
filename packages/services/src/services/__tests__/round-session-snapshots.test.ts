import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { coderRoundFileSnapshots222 } from '@mcp/store/migrations/222_coder_round_file_snapshots.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import { SessionSnapshotService } from '../session-snapshots.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'round-snapshot-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE session_file_baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_kind TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      project_id INTEGER,
      file_path TEXT NOT NULL,
      content_before TEXT,
      existed_before INTEGER NOT NULL,
      baseline_hash TEXT NOT NULL,
      oversized INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      first_seen_at TEXT NOT NULL,
      last_edited_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE UNIQUE INDEX idx_test_active_baseline
      ON session_file_baselines(session_kind, session_id, COALESCE(project_id, -1), file_path)
      WHERE status = 'active';
    CREATE TABLE session_file_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baseline_id INTEGER NOT NULL REFERENCES session_file_baselines(id) ON DELETE CASCADE,
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      content_after_hash TEXT NOT NULL,
      was_delete INTEGER NOT NULL DEFAULT 0,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE session_file_hunk_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baseline_id INTEGER NOT NULL REFERENCES session_file_baselines(id) ON DELETE CASCADE,
      hunk_fingerprint TEXT NOT NULL,
      decision TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_test_hunk
      ON session_file_hunk_decisions(baseline_id, hunk_fingerprint);
  `);
  coderRoundFileSnapshots222.up(db);
  const store = new SessionFileSnapshotStore(db);
  const service = new SessionSnapshotService(store, () => root);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, store, service };
}

function globalBaseline(
  store: SessionFileSnapshotStore,
  filePath: string,
  content: string,
  oversized = false,
) {
  return store.recordBaselineAndEdit({
    session_kind: 'coder',
    session_id: 1,
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
      session_id: 1,
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
    expect(store.listRoundSnapshots('coder', 1, 100, { includeClosed: true }))
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
      session_kind: 'coder', session_id: 1, round_message_id: 100,
      global_baseline_id: baseline.id, project_id: 10, file_path: 'src/a.ts',
      content_before: original, existed_before: true,
      content_after: roundOneAfter, existed_after: true, oversized: false,
    });
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: 1, round_message_id: 200,
      global_baseline_id: baseline.id, project_id: 10, file_path: 'src/a.ts',
      content_before: roundOneAfter, existed_before: true,
      content_after: roundTwoAfter, existed_after: true, oversized: false,
    });
    const abs = join(root, 'src', 'a.ts');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(abs, roundTwoAfter);

    const first = await service.listRoundFiles('coder', 1, 100);
    const second = await service.listRoundFiles('coder', 1, 200);
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
    expect((await service.listRoundFiles('coder', 1, 100))[0]).toMatchObject({
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
      session_kind: 'coder', session_id: 1, round_message_id: 100,
      global_baseline_id: baseline.id, project_id: 10, file_path: 'file.ts',
      content_before: original, existed_before: true,
      content_after: roundAfter, existed_after: true, oversized: false,
    });
    writeFileSync(join(root, 'file.ts'), current);

    const roundResult = await service.revertRoundAll('coder', 1, 100);
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
      session_kind: 'coder', session_id: 1, round_message_id: 100,
      global_baseline_id: aBaseline.id, project_id: 10, file_path: 'a.ts',
      content_before: 'a\n', existed_before: true,
      content_after: 'A\n', existed_after: true, oversized: false,
    });
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: 1, round_message_id: 100,
      global_baseline_id: bBaseline.id, project_id: 10, file_path: 'b.ts',
      content_before: 'b\n', existed_before: true,
      content_after: 'B\n', existed_after: true, oversized: false,
    });
    writeFileSync(join(root, 'a.ts'), 'A\n');
    writeFileSync(join(root, 'b.ts'), 'later-overlap\n');

    const result = await service.revertRoundAll('coder', 1, 100);
    expect(result.ok).toBe(false);
    expect(result.reverted).toBe(0);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(root, 'b.ts'), 'utf8')).toBe('later-overlap\n');
  });

  it('restores a round deletion beside a later non-overlapping edit', async () => {
    const { root, store, service } = harness();
    const baseline = globalBaseline(store, 'deleted-line.ts', 'a\nremove me\nc\n');
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: 1, round_message_id: 100,
      global_baseline_id: baseline.id, project_id: 10, file_path: 'deleted-line.ts',
      content_before: 'a\nremove me\nc\n', existed_before: true,
      content_after: 'a\nc\n', existed_after: true, oversized: false,
    });
    writeFileSync(join(root, 'deleted-line.ts'), 'A-later\nc\nfooter\n');

    expect(await service.revertRoundAll('coder', 1, 100))
      .toMatchObject({ ok: true, reverted: 1 });
    expect(readFileSync(join(root, 'deleted-line.ts'), 'utf8'))
      .toBe('A-later\nremove me\nc\nfooter\n');
  });

  it('rolls back both the creation and deletion sides of a rename', async () => {
    const { root, store, service } = harness();
    const oldBaseline = globalBaseline(store, 'old.ts', 'content\n');
    const newBaseline = store.recordBaselineAndEdit({
      session_kind: 'coder', session_id: 1, project_id: 10, file_path: 'new.ts',
      content_before: null, rollback_content: null, existed_before: false,
      baseline_hash: '', oversized: false,
    }, {
      turn_number: 1, tool_name: 'rename', content_after_hash: 'content', was_delete: false,
    }).baseline;
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: 1, round_message_id: 100,
      global_baseline_id: oldBaseline.id, project_id: 10, file_path: 'old.ts',
      content_before: 'content\n', existed_before: true,
      content_after: null, existed_after: false, oversized: false,
    });
    store.recordRoundSnapshotMutation({
      session_kind: 'coder', session_id: 1, round_message_id: 100,
      global_baseline_id: newBaseline.id, project_id: 10, file_path: 'new.ts',
      content_before: null, existed_before: false,
      content_after: 'content\n', existed_after: true, oversized: false,
    });
    writeFileSync(join(root, 'new.ts'), 'content\n');

    expect(await service.revertRoundAll('coder', 1, 100))
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
      session_id: 1,
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
