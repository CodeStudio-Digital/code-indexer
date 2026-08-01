import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';
import { listFilesystemTurnTelemetry } from '../telemetry-dashboard.js';
import { FsTurnTelemetryRepository } from '../turn-telemetry.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-turn-telemetry-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('FsTurnTelemetryRepository', () => {
  it('uses an idempotent UUID and cannot create a phantom completed turn', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Telemetry',
      provider: 'test',
      model: 'test',
    });
    const telemetry = new FsTurnTelemetryRepository(store);
    const input = {
      session_id: session.id,
      run_id: RUN_ID,
      turn: 3,
      is_subagent: false,
      provider: 'test',
      model: 'test',
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      thinking_tokens: null,
      history_chars: 400,
      tool_count: 2,
      tools_called: ['read_file', 'apply_patch'],
      largest_tool_result_chars: 250,
      compaction_triggered: false,
      summarizer_ran: false,
      paginate_count: 0,
    };

    const first = await telemetry.recordTurnTelemetry(input);
    const second = await telemetry.recordTurnTelemetry(input);

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).toBe(first);

    const metricsDirectory = join(
      projectRoot,
      '.mcp-indexer',
      'session',
      session.id,
      'metrics',
      'turns',
    );
    expect(await readdir(metricsDirectory)).toEqual([`${first}.json`]);
    const record = JSON.parse(
      await readFile(join(metricsDirectory, `${first}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(record.metric_kind).toBe('turn_telemetry');
    expect(record.turns).toBe(0);
    expect(record.tool_calls).toBe(0);

    const summary = await store.getMetricsSummary(session.id);
    expect(summary.turns).toBe(0);
    expect(summary.tool_calls).toBe(0);
    expect(summary.tokens.input).toBe(0);
  });

  it('fails closed for invalid run relations without writing a metric', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Invalid telemetry',
      provider: 'test',
      model: 'test',
    });
    const telemetry = new FsTurnTelemetryRepository(store);
    const input = {
      session_id: session.id,
      run_id: 'not-a-uuid',
      turn: 1,
      is_subagent: false,
      provider: 'test',
      model: 'test',
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      thinking_tokens: null,
      history_chars: null,
      tool_count: 0,
      tools_called: [],
      largest_tool_result_chars: null,
      compaction_triggered: false,
      summarizer_ran: false,
      paginate_count: 0,
    };

    expect(await telemetry.recordTurnTelemetry(input)).toBeNull();
    expect(
      await telemetry.recordTurnTelemetry({
        ...input,
        run_id: RUN_ID,
        parent_run_id: 'not-a-parent-uuid',
      }),
    ).toBeNull();

    expect(
      await readdir(
        join(
          projectRoot,
          '.mcp-indexer',
          'session',
          session.id,
          'metrics',
          'turns',
        ),
      ),
    ).toEqual([]);
  });

  it('reads only UUID telemetry records and incrementally caches immutable files', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Telemetry cache',
      provider: 'test',
      model: 'test',
    });
    const telemetry = new FsTurnTelemetryRepository(store);
    const input = {
      session_id: session.id,
      run_id: RUN_ID,
      turn: 1,
      is_subagent: false,
      provider: 'test',
      model: 'test',
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 0,
      thinking_tokens: null,
      history_chars: 20,
      tool_count: 0,
      tools_called: [],
      largest_tool_result_chars: null,
      compaction_triggered: false,
      summarizer_ran: false,
      paginate_count: 0,
    };
    await telemetry.recordTurnTelemetry(input);
    const location = await store.getSessionLocation(session.id);
    expect(location).not.toBeNull();
    await writeFile(
      join(location!.bundle_path, 'metrics', 'turns', 'turn-999.json'),
      '{legacy file must not be parsed',
      'utf8',
    );

    await expect(listFilesystemTurnTelemetry(store, session.id)).resolves.toHaveLength(1);
    await telemetry.recordTurnTelemetry({ ...input, turn: 2 });
    const rows = await listFilesystemTurnTelemetry(store, session.id);
    expect(rows.map((row) => row.turn)).toEqual([1, 2]);
  });

  it('records background subagent usage once per operation key', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Background usage',
      provider: 'test',
      model: 'test',
    });
    const usage = {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 5,
    };

    await store.bumpSessionUsage(session.id, usage, 'background-job:job-1');
    await store.bumpSessionUsage(session.id, usage, 'background-job:job-1');

    const summary = await store.getMetricsSummary(session.id);
    expect(summary.turns).toBe(0);
    expect(summary.tool_calls).toBe(0);
    expect(summary.tokens).toEqual({
      input: 120,
      output: 30,
      cache_read: 25,
      cache_creation: 5,
    });
    const metricFiles = await readdir(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      session.id,
      'metrics',
      'turns',
    ));
    expect(metricFiles).toHaveLength(1);
    expect(metricFiles[0]).toMatch(/^subagent-usage-[0-9a-f]{32}\.json$/);
  });
});
