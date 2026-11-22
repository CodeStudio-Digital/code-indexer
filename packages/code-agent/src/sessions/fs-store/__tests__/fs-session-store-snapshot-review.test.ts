import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

function openStore(): FsSessionStore {
  return FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
  });
}

async function restart(): Promise<void> {
  await store.close();
  store = openStore();
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-snapshot-review-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = openStore();
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('FsSessionStore snapshot and review repositories', () => {
  it('persists content-addressed baselines and round reviews idempotently', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Snapshot persistence',
      provider: 'test',
      model: 'test',
    });
    const baselineInput = {
      session_kind: 'coder' as const,
      session_id: session.id,
      project_id: 7,
      file_path: 'src/a.ts',
      content_before: 'export const value = 1;\n',
      rollback_content: 'export const value = 1;\n',
      existed_before: true,
      baseline_hash: 'before-hash',
      oversized: false,
      operation_id: 'snapshot-edit-one',
    };
    const editInput = {
      turn_number: 1,
      tool_name: 'edit_file',
      content_after_hash: 'after-hash',
      was_delete: false,
      operation_id: 'snapshot-edit-one',
    };

    const first = await store.recordBaselineAndEdit(
      baselineInput,
      editInput,
    );
    expect(first).toMatchObject({
      created: true,
      baseline: {
        id: expect.stringMatching(UUID_PATTERN),
        seq: 1,
        content_before: 'export const value = 1;\n',
        rollback_content: 'export const value = 1;\n',
      },
    });
    const replay = await store.recordBaselineAndEdit(
      baselineInput,
      editInput,
    );
    expect(replay.baseline.id).toBe(first.baseline.id);
    expect(await store.listEdits(first.baseline.id)).toHaveLength(1);
    await expect(
      store.recordBaselineAndEdit(
        baselineInput,
        { ...editInput, content_after_hash: 'conflicting-hash' },
      ),
    ).rejects.toThrow(/operation_id .* different/i);

    const round = await store.recordRoundSnapshotMutation({
      session_kind: 'coder',
      session_id: session.id,
      round_message_id: 4,
      global_baseline_id: first.baseline.id,
      project_id: 7,
      file_path: 'src/a.ts',
      content_before: 'export const value = 1;\n',
      existed_before: true,
      content_after: 'export const value = 2;\n',
      existed_after: true,
      oversized: false,
      operation_id: 'round-snapshot-one',
    });
    await store.upsertRoundHunkDecision(round.id, 'hunk-one', 'kept');
    const findings = await store.replaceRoundReviewFindings(
      [round.id],
      [{
        round_snapshot_id: round.id,
        severity: 'medium',
        body: 'Check the updated value.',
        operation_id: 'round-review-one',
      }],
    );
    expect(findings[0]).toMatchObject({
      id: expect.stringMatching(UUID_PATTERN),
      round_snapshot_id: round.id,
    });
    const findingsReplay = await store.replaceRoundReviewFindings(
      [round.id],
      [{
        round_snapshot_id: round.id,
        severity: 'medium',
        body: 'Check the updated value.',
        operation_id: 'round-review-one',
      }],
    );
    expect(findingsReplay[0]?.id).toBe(findings[0]?.id);

    const bundle = join(
      projectRoot,
      '.mcp-indexer',
      'session',
      session.id,
    );
    const snapshotFiles = (await readdir(join(bundle, 'snapshots')))
      .filter((name) => name.endsWith('.json'));
    const baselineEnvelopePath = join(
      bundle,
      'snapshots',
      `${first.baseline.id}.json`,
    );
    const baselineEnvelope = JSON.parse(
      await readFile(baselineEnvelopePath, 'utf8'),
    ) as {
      data: {
        content_before: { relative_path: string; sha256: string };
        rollback_content: { relative_path: string; sha256: string };
      };
    };
    expect(snapshotFiles.length).toBeGreaterThanOrEqual(3);
    expect(baselineEnvelope.data.content_before.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await readFile(
        join(bundle, ...baselineEnvelope.data.content_before.relative_path.split('/')),
        'utf8',
      ),
    ).toBe('export const value = 1;\n');

    await restart();
    expect(await store.getBaselineById(first.baseline.id)).toMatchObject({
      content_before: 'export const value = 1;\n',
    });
    expect(await store.getRoundSnapshotById(round.id)).toMatchObject({
      content_after: 'export const value = 2;\n',
    });
    expect(await store.listRoundHunkDecisions(round.id)).toHaveLength(1);
    expect(
      await store.listRoundReviewFindings('coder', session.id, 4),
    ).toHaveLength(1);
  });

  it('keeps snapshot artifact reads lease-free while another store owns the writer', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Concurrent snapshot reader',
      provider: 'test',
      model: 'test',
    });
    const { baseline } = await store.recordBaselineAndEdit(
      {
        session_kind: 'coder',
        session_id: session.id,
        project_id: 7,
        file_path: 'src/concurrent.ts',
        content_before: 'export const before = true;\n',
        rollback_content: 'export const before = true;\n',
        existed_before: true,
        baseline_hash: 'concurrent-before',
        oversized: false,
        operation_id: 'concurrent-baseline',
      },
      {
        turn_number: 1,
        tool_name: 'edit_file',
        content_after_hash: 'concurrent-after',
        was_delete: false,
        operation_id: 'concurrent-baseline',
      },
    );
    const round = await store.recordRoundSnapshotMutation({
      session_kind: 'coder',
      session_id: session.id,
      round_message_id: 1,
      global_baseline_id: baseline.id,
      project_id: 7,
      file_path: 'src/concurrent.ts',
      content_before: 'export const before = true;\n',
      existed_before: true,
      content_after: 'export const after = true;\n',
      existed_after: true,
      oversized: false,
      operation_id: 'concurrent-round',
    });
    const run = await store.createRun({
      session_kind: 'coder',
      session_id: session.id,
      source: 'manual',
      operation_id: 'concurrent-review',
    });
    await store.completeRun(run.id, {
      status: 'completed',
      raw_response: '{"findings":[]}',
      operation_id: 'concurrent-review-complete',
    });

    const reader = openStore();
    try {
      await expect(reader.listBaselines('coder', session.id)).resolves.toEqual([
        expect.objectContaining({
          id: baseline.id,
          content_before: 'export const before = true;\n',
        }),
      ]);
      await expect(
        reader.listRoundSnapshots('coder', session.id, 1),
      ).resolves.toEqual([
        expect.objectContaining({
          id: round.id,
          content_after: 'export const after = true;\n',
        }),
      ]);
      await expect(reader.getRun(run.id)).resolves.toEqual(
        expect.objectContaining({
          id: run.id,
          raw_response: '{"findings":[]}',
        }),
      );
      expect(await reader.listRoundSnapshots('coder', session.id, 2)).toEqual([]);
      const nextRound = await store.recordRoundSnapshotMutation({
        session_kind: 'coder', session_id: session.id, round_message_id: 2,
        global_baseline_id: baseline.id, project_id: 7, file_path: 'src/concurrent.ts',
        content_before: 'previous', content_after: 'latest', existed_before: true, existed_after: true, oversized: false,
      });
      expect(await reader.listRoundSnapshots('coder', session.id, 2)).toMatchObject([{ id: nextRound.id, content_after: 'latest' }]);
      await store.closeRoundSnapshot(nextRound.id, 'closed_kept');
      expect(await reader.listRoundSnapshots('coder', session.id, 2)).toEqual([]);
      expect(await reader.listRoundSnapshots('coder', session.id, 2, { includeClosed: true })).toMatchObject([{ id: nextRound.id, status: 'closed_kept' }]);
    } finally {
      await reader.close();
    }
  });

  it('persists review runs, comments, intent, fates and evidence across restart', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Review persistence',
      provider: 'test',
      model: 'test',
    });
    await store.persistAssistantTurn({
      session_id: session.id,
      operation_id: 'verify-turn',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'verify-call',
          name: 'run_command',
          input: { command: 'pnpm test' },
        }],
      },
      usage: null,
      tool_calls: [{
        tool_use_id: 'verify-call',
        tool_name: 'run_command',
        args: { command: 'pnpm test' },
        result_text: 'suite ok exit=0',
        is_error: false,
        duration_ms: 12,
      }],
    });
    const { baseline } = await store.recordBaselineAndEdit(
      {
        session_kind: 'coder',
        session_id: session.id,
        project_id: 7,
        file_path: 'src/review.ts',
        content_before: 'before\n',
        existed_before: true,
        baseline_hash: 'before',
        oversized: false,
        operation_id: 'review-baseline',
      },
      {
        turn_number: 2,
        tool_name: 'edit_file',
        content_after_hash: 'after',
        was_delete: false,
        operation_id: 'review-baseline',
      },
    );
    const run = await store.createRun({
      session_kind: 'coder',
      session_id: session.id,
      source: 'auto',
      operation_id: 'review-run-one',
    });
    await store.completeRun(run.id, {
      status: 'completed',
      provider_id: 'test',
      model_id: 'reviewer',
      raw_response: '{"findings":[{"severity":"low"}]}',
      operation_id: 'review-run-one-complete',
    });
    const comment = await store.createComment({
      run_id: run.id,
      baseline_id: baseline.id,
      source: 'auto',
      file_path: 'src/review.ts',
      severity: 'low',
      body: 'A concrete review finding.',
      operation_id: 'review-comment-one',
    });
    await store.updateComment(comment.id, {
      status: 'dismissed',
      operation_id: 'dismiss-comment-one',
    });
    await store.saveContract({
      session_kind: 'coder',
      session_id: session.id,
      source_hash: 'intent-hash',
      obligations_json: '[{"id":"O1"}]',
      provider_id: 'test',
      model_id: 'intent',
    });
    await store.recordFate({
      comment_id: comment.id,
      session_kind: 'coder',
      session_id: session.id,
      category: 'defect',
      severity: 'low',
      file_path: 'src/review.ts',
      outcome: 'dismissed',
    });

    await restart();
    expect(await store.getRun(run.id)).toMatchObject({
      status: 'completed',
      raw_response: '{"findings":[{"severity":"low"}]}',
    });
    expect(await store.getComment(comment.id)).toMatchObject({
      status: 'dismissed',
      baseline_id: baseline.id,
    });
    expect(
      await store.getContract('coder', session.id, 'intent-hash'),
    ).toBe('[{"id":"O1"}]');
    expect(await store.aggregateFates(7)).toEqual([
      expect.objectContaining({
        category: 'defect',
        dismissed: 1,
        total: 1,
      }),
    ]);
    expect(await store.recentDismissals(3, 7)).toEqual([
      expect.objectContaining({
        file_path: 'src/review.ts',
        body: 'A concrete review finding.',
      }),
    ]);
    expect(
      await store.listReviewEvidenceToolCalls(session.id),
    ).toEqual([
      expect.objectContaining({
        args_json: '{"command":"pnpm test"}',
        result_text: 'suite ok exit=0',
      }),
    ]);
    expect(await store.listReviewEvidenceEdits(session.id)).toEqual([
      expect.objectContaining({ file_path: 'src/review.ts' }),
    ]);
  });

  it('reads one snapshot by UUID without scanning unrelated entity files', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Direct snapshot lookup',
      provider: 'test',
      model: 'test',
    });
    const record = (file_path: string, operation_id: string) =>
      store.recordBaselineAndEdit(
        {
          session_kind: 'coder',
          session_id: session.id,
          project_id: 7,
          file_path,
          content_before: 'before',
          existed_before: true,
          baseline_hash: `hash-${file_path}`,
          oversized: false,
        },
        {
          turn_number: 1,
          tool_name: 'edit_file',
          content_after_hash: `after-${file_path}`,
          was_delete: false,
          operation_id,
        },
      );
    const first = await record('src/first.ts', 'direct-first');
    const sibling = await record('src/sibling.ts', 'direct-sibling');
    const location = await store.getSessionLocation(session.id);
    expect(location).not.toBeNull();
    await writeFile(
      join(location!.bundle_path, 'snapshots', `${sibling.baseline.id}.json`),
      '{corrupt sibling',
      'utf8',
    );

    await expect(store.getBaselineById(first.baseline.id)).resolves.toMatchObject({
      id: first.baseline.id,
      file_path: 'src/first.ts',
    });
    await expect(
      store.listBaselines('coder', session.id, { includeClosed: true }),
    ).rejects.toThrow();
  });

  it('rejects snapshot paths that escape the owning project', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Traversal guard',
      provider: 'test',
      model: 'test',
    });
    await expect(
      store.recordBaselineAndEdit(
        {
          session_kind: 'coder',
          session_id: session.id,
          project_id: 7,
          file_path: '../outside.ts',
          content_before: 'secret',
          existed_before: true,
          baseline_hash: 'before',
          oversized: false,
        },
        {
          turn_number: 1,
          tool_name: 'edit_file',
          content_after_hash: 'after',
          was_delete: false,
        },
      ),
    ).rejects.toThrow('Invalid snapshot file path');
    expect(
      await store.listBaselines('coder', session.id, {
        includeClosed: true,
      }),
    ).toEqual([]);
  });
});
