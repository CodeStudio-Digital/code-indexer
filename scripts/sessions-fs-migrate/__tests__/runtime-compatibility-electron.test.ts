import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '../../../packages/code-agent/src/sessions/fs-store/fs-session-store.js';
import {
  CompanySessionRepository,
  SpriteSessionRepository,
} from '../../../packages/session-storage/src/index.js';
import {
  commitStagingBundle,
  prepareStagingBundle,
} from '../bundles.js';
import { loadDatabaseConstructor } from '../db.js';
import { exportBundle } from '../exporter.js';
import type {
  BundlePlan,
  MigrationRunState,
  ProjectRow,
} from '../model.js';
import { buildRelationalExportIndex } from '../relational.js';
import { UuidRegistry } from '../uuid-map.js';
import {
  smokeOperationalBundleRepositories,
  verifyBundle,
} from '../verify.js';

const cleanup: string[] = [];
const electronDescribe = process.versions.electron ? describe : describe.skip;

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

electronDescribe('migrated bundle runtime compatibility', () => {
  it('reopens conversation, tools, goal, plans, tasks, metrics and state through FsSessionStore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-runtime-compat-'));
    cleanup.push(root);
    const projectRoot = join(root, 'project');
    const dataDir = join(root, 'data');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const Database = loadDatabaseConstructor();
    const db = new Database(':memory:');
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          root_path TEXT NOT NULL,
          name TEXT,
          is_synthetic INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE coder_sessions (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          agent TEXT,
          status TEXT NOT NULL,
          is_global INTEGER NOT NULL DEFAULT 0,
          is_favorite INTEGER NOT NULL DEFAULT 0,
          favorited_at TEXT,
          archived_at TEXT,
          total_input_tokens INTEGER NOT NULL DEFAULT 0,
          total_output_tokens INTEGER NOT NULL DEFAULT 0,
          total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          last_turn_input_tokens INTEGER NOT NULL DEFAULT 0,
          goal_text TEXT,
          goal_status TEXT,
          goal_budget_tokens INTEGER,
          goal_completion_note TEXT,
          goal_created_at TEXT,
          goal_updated_at TEXT,
          todos_json TEXT,
          tool_permission_mode TEXT,
          tool_permission_grants TEXT,
          tool_profile TEXT,
          tool_state_json TEXT,
          summary_boundary_id INTEGER,
          compaction_summary TEXT,
          compaction_count_auto INTEGER NOT NULL DEFAULT 0,
          compaction_count_manual INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE coder_messages (
          id INTEGER PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES coder_sessions(id),
          role TEXT NOT NULL,
          content_json TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          is_meta INTEGER NOT NULL DEFAULT 0,
          selected_skill_ids_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE coder_tool_calls (
          id INTEGER PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES coder_sessions(id),
          message_id INTEGER REFERENCES coder_messages(id),
          tool_use_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          args_json TEXT NOT NULL,
          result_text TEXT,
          is_error INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE coder_plans (
          id INTEGER PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES coder_sessions(id),
          tool_use_id TEXT NOT NULL,
          message_id INTEGER REFERENCES coder_messages(id),
          plan_text TEXT NOT NULL,
          status TEXT NOT NULL,
          feedback TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE TABLE coder_tasks_state (
          session_id INTEGER PRIMARY KEY REFERENCES coder_sessions(id),
          tool_use_id TEXT NOT NULL,
          state TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE session_disabled_tools (
          session_id INTEGER NOT NULL REFERENCES coder_sessions(id),
          tool_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, tool_name)
        );
        CREATE TABLE coder_session_chapters (
          id INTEGER PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES coder_sessions(id),
          ordinal INTEGER NOT NULL,
          start_message_id INTEGER NOT NULL,
          end_message_id INTEGER NOT NULL,
          source TEXT NOT NULL,
          trigger TEXT NOT NULL,
          title TEXT NOT NULL,
          chapter_json TEXT NOT NULL,
          chapter_text TEXT NOT NULL,
          resume_json TEXT NOT NULL,
          resume_text TEXT NOT NULL,
          version INTEGER NOT NULL,
          metrics_json TEXT,
          created_at TEXT NOT NULL,
          superseded_at TEXT,
          chapter_kind TEXT,
          advances_context_boundary INTEGER
        );
        CREATE TABLE coder_subagent_runs (
          id INTEGER PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES coder_sessions(id),
          run_id TEXT NOT NULL UNIQUE,
          parent_run_id TEXT,
          spawn_id TEXT,
          profile TEXT NOT NULL,
          label TEXT,
          task_preview TEXT,
          max_turns INTEGER,
          max_tool_calls INTEGER,
          timeout_ms INTEGER,
          stall_ms INTEGER,
          reason TEXT,
          turns INTEGER NOT NULL DEFAULT 0,
          auto_continues INTEGER NOT NULL DEFAULT 0,
          tool_calls INTEGER NOT NULL DEFAULT 0,
          logical_operations INTEGER NOT NULL DEFAULT 0,
          productive_operations INTEGER NOT NULL DEFAULT 0,
          paginate_calls INTEGER NOT NULL DEFAULT 0,
          duplicate_calls INTEGER NOT NULL DEFAULT 0,
          error_calls INTEGER NOT NULL DEFAULT 0,
          refused_calls INTEGER NOT NULL DEFAULT 0,
          elapsed_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          has_summary INTEGER NOT NULL DEFAULT 0,
          output_id TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          research_depth TEXT,
          soft_tool_target INTEGER,
          soft_time_target_ms INTEGER,
          synthesis_nudged INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          heartbeat_at TEXT,
          worker_instance_id TEXT
        );
        CREATE TABLE coder_subagent_tool_calls (
          id INTEGER PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES coder_sessions(id),
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          turn INTEGER,
          tool_name TEXT NOT NULL,
          logical_operation_id TEXT,
          productive INTEGER NOT NULL DEFAULT 0,
          is_error INTEGER NOT NULL DEFAULT 0,
          refusal_kind TEXT,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          result_chars INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE session_file_baselines (
          id INTEGER PRIMARY KEY,
          session_kind TEXT NOT NULL,
          session_id INTEGER NOT NULL,
          project_id INTEGER,
          file_path TEXT NOT NULL,
          content_before TEXT,
          rollback_content TEXT,
          existed_before INTEGER NOT NULL,
          baseline_hash TEXT NOT NULL,
          oversized INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_edited_at TEXT NOT NULL,
          closed_at TEXT
        );
        CREATE TABLE session_file_edits (
          id INTEGER PRIMARY KEY,
          baseline_id INTEGER NOT NULL REFERENCES session_file_baselines(id),
          turn_number INTEGER,
          tool_name TEXT NOT NULL,
          content_after_hash TEXT NOT NULL,
          was_delete INTEGER NOT NULL DEFAULT 0,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE session_file_review_runs (
          id INTEGER PRIMARY KEY,
          session_kind TEXT NOT NULL,
          session_id INTEGER NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          provider_id TEXT,
          model_id TEXT,
          raw_response TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE TABLE skill_definitions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          scope TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE skill_session_config (
          session_id INTEGER NOT NULL REFERENCES coder_sessions(id),
          skill_id TEXT NOT NULL REFERENCES skill_definitions(id),
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, skill_id)
        );
      `);
      db.prepare(
        `INSERT INTO projects (id, root_path, name) VALUES (1, ?, 'fixture')`,
      ).run(projectRoot);
      db.exec(`
        INSERT INTO coder_sessions (
          id, project_id, title, provider, model, agent, status,
          total_input_tokens, total_output_tokens, last_turn_input_tokens,
          goal_text, goal_status, goal_budget_tokens,
          goal_created_at, goal_updated_at, tool_permission_mode,
          tool_permission_grants, tool_profile, tool_state_json,
          summary_boundary_id, compaction_summary,
          created_at, updated_at
        ) VALUES (
          7, 1, 'Migrated', 'fixture-provider', 'fixture-model', 'coder',
          'running', 11, 7, 11, 'Ship filesystem sessions', 'in_progress',
          1234, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:03.000Z',
          'ask', '["read_file"]', 'full',
          '{"v":1,"extraTiers":[],"pins":[],"visibleCap":null}',
          1, 'legacy summary', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:03.000Z'
        );
        INSERT INTO coder_messages VALUES (
          1, 7, 'user',
          '[{"type":"text","text":"hello"},{"type":"image","mediaType":"image/png","base64":"aW1hZ2U="}]',
          11, 0, 3, 1, 0, '["fixture-skill"]',
          '2026-01-01T00:00:01.000Z'
        );
        INSERT INTO coder_messages VALUES (
          2, 7, 'assistant',
          '[{"type":"tool_use","id":"tool-1","name":"read_file","input":{"path":"a.txt"}}]',
          0, 7, 0, 0, 0, NULL, '2026-01-01T00:00:02.000Z'
        );
        INSERT INTO coder_messages VALUES (
          3, 7, 'tool',
          '[{"type":"tool_result","tool_use_id":"tool-1","content":"legacy-inline","is_error":false}]',
          0, 0, 0, 0, 0, NULL, '2026-01-01T00:00:03.000Z'
        );
        INSERT INTO coder_tool_calls (
          id, session_id, message_id, tool_use_id, tool_name, args_json,
          result_text, is_error, duration_ms, created_at
        ) VALUES (
          9, 7, 2, 'tool-1', 'read_file', '{"path":"a.txt"}',
          'tool output', 0, 12, '2026-01-01T00:00:02.000Z'
        );
        INSERT INTO coder_tool_calls (
          id, session_id, message_id, tool_use_id, tool_name, args_json,
          result_text, is_error, duration_ms, created_at
        ) VALUES (
          10, 7, 2, 'duplicate-tool', 'run_command', '{"command":"first"}',
          'first duplicate output', 1, 5, '2026-01-01T00:00:02.000Z'
        );
        INSERT INTO coder_tool_calls (
          id, session_id, message_id, tool_use_id, tool_name, args_json,
          result_text, is_error, duration_ms, created_at
        ) VALUES (
          11, 7, 2, 'duplicate-tool', 'read_file', '{"path":"second"}',
          'second duplicate output', 0, 6, '2026-01-01T00:00:02.000Z'
        );
        INSERT INTO coder_plans VALUES (
          4, 7, 'plan-1', 2, 'Do the migration', 'approved', NULL,
          '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:03.000Z'
        );
        INSERT INTO coder_tasks_state VALUES (
          7, 'tasks-1',
          '{"summary":"Migrate","tasks":[],"execution_mode":"smart","approved":true,"current_task_id":null}',
          1, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:03.000Z'
        );
        INSERT INTO session_disabled_tools VALUES (
          7, 'run_command', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO coder_session_chapters VALUES (
          12, 7, 1, 1, 1, 'legacy', 'migration_208',
          'Legacy chapter', '{"facts":["one"]}', 'chapter text',
          '{"next":"continue"}', 'resume text', 2, '{"backfilled":true}',
          '2026-01-01T00:00:01.000Z', NULL, 'context', 1
        );
        INSERT INTO coder_subagent_runs VALUES (
          13, 7, 'legacy-run-1', NULL, 'spawn-1', 'explore',
          'Legacy explorer', 'inspect storage', 4, 8, 30000, 5000,
          'completed', 2, 0, 1, 1, 1, 0, 0, 0, 0, 1200,
          10, 5, 0, 0, 1, 'legacy-output',
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z',
          'standard', 4, 15000, 0, 'completed',
          '2026-01-01T00:00:02.000Z', 'legacy-worker'
        );
        INSERT INTO coder_subagent_tool_calls VALUES (
          14, 7, 'legacy-run-1', 1, 1, 'read_file', 'op-1',
          1, 0, NULL, 25, 120, '2026-01-01T00:00:01.000Z'
        );
        INSERT INTO session_file_baselines VALUES (
          21, 'coder', 7, 1, 'src/file.ts', 'before payload',
          'rollback payload', 1, 'baseline-hash-text', 0, 'active',
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', NULL
        );
        INSERT INTO session_file_edits VALUES (
          22, 21, 1, 'write_file', 'content-after-hash-text', 0,
          '2026-01-01T00:00:02.000Z'
        );
        INSERT INTO session_file_review_runs VALUES (
          23, 'coder', 7, 'automatic', 'completed', 'provider', 'model',
          '{"findings":[]}', NULL, '2026-01-01T00:00:02.000Z',
          '2026-01-01T00:00:03.000Z'
        );
        INSERT INTO skill_definitions VALUES (
          'fixture-skill', 'Fixture', 'global', 1, 0
        );
        INSERT INTO skill_session_config VALUES (
          7, 'fixture-skill', 1, '2026-01-01T00:00:00.000Z'
        );
      `);
      mkdirSync(join(dataDir, 'coder-tool-outputs', '7'), {
        recursive: true,
      });
      writeFileSync(
        join(dataDir, 'coder-tool-outputs', '7', 'unclaimed.txt'),
        'legacy spill payload',
      );

      const fingerprint = 'f'.repeat(64);
      const registry = new UuidRegistry(null, fingerprint);
      const sessionUuid = registry.forSession({ kind: 'coder', id: 7 });
      const plan: BundlePlan = {
        identity: { kind: 'coder', id: 7 },
        uuid: sessionUuid,
        scope: 'project',
        projectRoot,
        finalDir: join(projectRoot, '.mcp-indexer', 'session', sessionUuid),
        stagingDir: join(
          projectRoot,
          '.mcp-indexer',
          'session',
          `.migrating-${sessionUuid}`,
        ),
      };
      const projects: ProjectRow[] = [
        { id: 1, root_path: projectRoot, name: 'fixture', is_synthetic: 0 },
      ];
      const relational = buildRelationalExportIndex(db, [plan], registry);
      prepareStagingBundle(plan, fingerprint);
      const runState: MigrationRunState = {
        format_version: 1,
        source_db_path: 'fixture.db',
        source_db_fingerprint: fingerprint,
        source_db_bytes: 0,
        phase: 'exporting',
        started_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        expected_counts: {},
        exported_counts: {},
        legacy_orphan_cleanup: {},
        roots: [projectRoot],
      };
      await exportBundle({
        db,
        dataDir,
        sourceFingerprint: fingerprint,
        projects,
        relational,
        sealer: { seal: (value) => value },
        logger: { info: () => undefined, warn: () => undefined },
        runState,
      }, plan);
      expect(() =>
        verifyBundle(plan.stagingDir, sessionUuid, fingerprint, 'staging')
      ).not.toThrow();
      commitStagingBundle(plan, fingerprint);
      expect(() =>
        verifyBundle(plan.finalDir, sessionUuid, fingerprint, 'committed')
      ).not.toThrow();
      await expect(
        smokeOperationalBundleRepositories([plan]),
      ).resolves.toBeUndefined();

      const store = FsSessionStore.fromRoots({
        dataDir,
        projectRootResolver: {
          resolveProjectRoot: () => projectRoot,
          listProjectRoots: () => [{ project_id: 1, root_path: projectRoot }],
        },
      });
      await store.refresh();
      const session = await store.getSession(sessionUuid);
      expect(session).toMatchObject({
        id: sessionUuid,
        status: 'interrupted',
        agent: 'coder',
        tool_permission_mode: 'ask',
        tool_profile: 'full',
        summary_boundary_id: 1,
      });
      expect(session?.state.tools).toMatchObject({
        disabled: ['run_command'],
        active_skills: ['fixture-skill'],
      });

      const loaded = await store.loadSessionWithMessages(sessionUuid);
      expect(loaded?.message_rows.map((row) => row.seq)).toEqual([2, 3]);
      const archived = await store.loadMessagesBefore(
        sessionUuid,
        4,
        10,
        true,
      );
      expect(archived.message_rows.map((row) => row.seq)).toEqual([1, 2, 3]);
      expect(archived.messages[0].content).toMatchObject([
        { type: 'text', text: 'hello' },
        { type: 'image', mediaType: 'image/png' },
      ]);
      expect(archived.messages[2].content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'tool output',
          is_error: false,
        },
      ]);
      expect(await store.getToolOutput(sessionUuid, 'tool-1')).toMatchObject({
        record: { call_id: 'tool-1' },
      });
      const duplicateFirstEntityId = registry.get('coder_tool_calls:10');
      expect(duplicateFirstEntityId).toBeTruthy();
      const disambiguatedCallId = `legacy-duplicate:${duplicateFirstEntityId}`;
      expect(
        await store.getToolOutput(sessionUuid, disambiguatedCallId),
      ).toMatchObject({
        record: {
          call_id: disambiguatedCallId,
          metadata: {
            legacy_tool_use_id: 'duplicate-tool',
            legacy_tool_use_id_collision: true,
            legacy_duplicate_ordinal: 1,
            legacy_duplicate_count: 2,
          },
        },
      });
      expect(
        await store.getToolOutput(sessionUuid, 'duplicate-tool'),
      ).toMatchObject({
        record: {
          call_id: 'duplicate-tool',
          metadata: {
            legacy_tool_use_id: 'duplicate-tool',
            legacy_tool_use_id_collision: true,
            legacy_duplicate_ordinal: 2,
            legacy_duplicate_count: 2,
          },
        },
      });
      const duplicateResults = await store.getToolResultsByToolUseIds(
        sessionUuid,
        [disambiguatedCallId, 'duplicate-tool'],
      );
      expect(
        duplicateResults.map((result) => ({
          tool_use_id: result.tool_use_id,
          tool_name: result.tool_name,
          result_text: result.result_text,
        })),
      ).toEqual([
        {
          tool_use_id: disambiguatedCallId,
          tool_name: 'run_command',
          result_text: 'first duplicate output',
        },
        {
          tool_use_id: 'duplicate-tool',
          tool_name: 'read_file',
          result_text: 'second duplicate output',
        },
      ]);
      expect(await store.getSessionGoal(sessionUuid)).toMatchObject({
        text: 'Ship filesystem sessions',
        status: 'in_progress',
        budget_tokens: 1234,
      });
      expect(await store.listPlans(sessionUuid)).toMatchObject([
        {
          tool_use_id: 'plan-1',
          message_seq: 2,
          plan_text: 'Do the migration',
          status: 'approved',
        },
      ]);
      expect(await store.getTasksState(sessionUuid)).toMatchObject({
        summary: 'Migrate',
        approved: true,
      });
      expect(await store.getMetricsSummary(sessionUuid)).toMatchObject({
        turns: 1,
        tool_calls: 3,
        tokens: {
          input: 11,
          output: 7,
          cache_read: 3,
          cache_creation: 1,
        },
      });
      expect(await store.rebuildMetricsSummary(sessionUuid)).toMatchObject({
        turns: 1,
        tool_calls: 3,
      });
      const chapters = await store.listConversationChapters(sessionUuid);
      expect(chapters.items).toMatchObject([
        {
          start_message_seq: 1,
          end_message_seq: 1,
          chapter_json: '{"facts":["one"]}',
          resume_json: '{"next":"continue"}',
          chapter_kind: 'context',
        },
      ]);
      expect(await store.recoverOrphanedSubagentRuns()).toBe(0);

      const readOnlyRecord = (
        directory: string,
      ): Record<string, unknown> => {
        const file = readdirSync(directory).find((name) => name.endsWith('.json'));
        if (!file) throw new Error(`missing migrated record in ${directory}`);
        return JSON.parse(
          readFileSync(join(directory, file), 'utf8'),
        ) as Record<string, unknown>;
      };
      const subagentRecords = readdirSync(
        join(plan.finalDir, 'subagents'),
      ).map((file) =>
        JSON.parse(
          readFileSync(join(plan.finalDir, 'subagents', file), 'utf8'),
        ) as { kind: string; data: Record<string, unknown> }
      );
      const subagentRecord = subagentRecords.find(
        (record) => record.kind === 'subagent_run',
      );
      expect(subagentRecord?.data).toMatchObject({
        status: 'completed',
        profile: 'explore',
        has_summary: true,
      });
      expect(subagentRecord?.data.run_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(subagentRecord?.data.fence_token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const subagentToolCall = subagentRecords.find(
        (record) => record.kind === 'subagent_tool_call',
      );
      expect(subagentToolCall?.data).toMatchObject({
        run_id: subagentRecord?.data.run_id,
        seq: 1,
        tool_name: 'read_file',
      });
      const baselineRecord = readOnlyRecord(
        join(plan.finalDir, 'snapshots', 'session_file_baselines'),
      ) as { data: Record<string, unknown> };
      expect(baselineRecord.data.baseline_hash).toBe('baseline-hash-text');
      const beforeRef = baselineRecord.data.content_before as {
        relative_path: string;
      };
      expect(
        readFileSync(
          join(plan.finalDir, ...beforeRef.relative_path.split('/')),
          'utf8',
        ),
      ).toBe('before payload');

      const editRecord = readOnlyRecord(
        join(plan.finalDir, 'snapshots', 'session_file_edits'),
      ) as { data: Record<string, unknown> };
      expect(editRecord.data.content_after_hash).toBe(
        'content-after-hash-text',
      );
      const reviewRecord = readOnlyRecord(
        join(plan.finalDir, 'snapshots', 'session_file_review_runs'),
      ) as { data: Record<string, unknown> };
      expect(reviewRecord.data.raw_response).toBe('{"findings":[]}');

      const spill = JSON.parse(
        readFileSync(
          join(
            plan.finalDir,
            'tools_outputs',
            'legacy_spills',
            'unclaimed.json',
          ),
          'utf8',
        ),
      ) as { raw: { relative_path: string } };
      expect(
        readFileSync(
          join(plan.finalDir, ...spill.raw.relative_path.split('/')),
          'utf8',
        ),
      ).toBe('legacy spill payload');
    } finally {
      db.close();
    }
  });

  it('reopens Company and Sprite operational entities through their canonical repositories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-operational-compat-'));
    cleanup.push(root);
    const projectRoot = join(root, 'project');
    const dataDir = join(root, 'data');
    mkdirSync(join(projectRoot, '.sprite-studio'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, 'sandboxes'), { recursive: true });
    writeFileSync(join(dataDir, 'sandboxes', '3.tar'), Buffer.from('legacy-workdir'));
    writeFileSync(
      join(projectRoot, '.sprite-studio', 'hero.png'),
      Buffer.from('fixture-sprite'),
    );

    const Database = loadDatabaseConstructor();
    const db = new Database(':memory:');
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          root_path TEXT NOT NULL,
          name TEXT,
          is_synthetic INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE company_sessions (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          runtime_kind TEXT NOT NULL,
          config_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE company_board (
          id INTEGER PRIMARY KEY,
          company_session_id INTEGER NOT NULL REFERENCES company_sessions(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE sprite_projects (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          style_json TEXT,
          export_dir TEXT,
          settings_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE sprite_assets (
          id INTEGER PRIMARY KEY,
          sprite_project_id INTEGER NOT NULL REFERENCES sprite_projects(id),
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          file_rel_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO projects (id, root_path, name) VALUES (1, ?, 'fixture')`,
      ).run(projectRoot);
      db.exec(`
        INSERT INTO company_sessions VALUES (
          3, 'Fixture Company', 'running', 'company', '{"mode":"fixture"}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
        );
        INSERT INTO company_board VALUES (
          8, 3, 'Ship the cutover', 'doing',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
        );
        INSERT INTO sprite_projects VALUES (
          5, 1, 'Fixture Sprite', 'active', '{"palette":"warm"}',
          'assets/sprites', '{"scale":2}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
        );
        INSERT INTO sprite_assets VALUES (
          12, 5, 'Hero', 'ready', 'hero.png',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
        );
      `);

      const fingerprint = 'e'.repeat(64);
      const registry = new UuidRegistry(null, fingerprint);
      const companyUuid = registry.forSession({ kind: 'company', id: 3 });
      const spriteUuid = registry.forSession({ kind: 'sprite', id: 5 });
      const plans: BundlePlan[] = [
        {
          identity: { kind: 'company', id: 3 },
          uuid: companyUuid,
          scope: 'global',
          finalDir: join(dataDir, 'sessions', 'global', companyUuid),
          stagingDir: join(
            dataDir,
            'sessions',
            'global',
            `.migrating-${companyUuid}`,
          ),
        },
        {
          identity: { kind: 'sprite', id: 5 },
          uuid: spriteUuid,
          scope: 'project',
          projectRoot,
          finalDir: join(projectRoot, '.mcp-indexer', 'session', spriteUuid),
          stagingDir: join(
            projectRoot,
            '.mcp-indexer',
            'session',
            `.migrating-${spriteUuid}`,
          ),
        },
      ];
      const projects: ProjectRow[] = [
        { id: 1, root_path: projectRoot, name: 'fixture', is_synthetic: 0 },
      ];
      const relational = buildRelationalExportIndex(db, plans, registry);
      const runState: MigrationRunState = {
        format_version: 1,
        source_db_path: 'fixture.db',
        source_db_fingerprint: fingerprint,
        source_db_bytes: 0,
        phase: 'exporting',
        started_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        expected_counts: {},
        exported_counts: {},
        legacy_orphan_cleanup: {},
        roots: [projectRoot, dataDir],
      };
      for (const plan of plans) {
        prepareStagingBundle(plan, fingerprint);
        await exportBundle({
          db,
          dataDir,
          sourceFingerprint: fingerprint,
          projects,
          relational,
          sealer: { seal: (value) => value },
          logger: { info: () => undefined, warn: () => undefined },
          runState,
        }, plan);
        expect(() =>
          verifyBundle(plan.stagingDir, plan.uuid, fingerprint, 'staging')
        ).not.toThrow();
        commitStagingBundle(plan, fingerprint);
      }
      await expect(
        smokeOperationalBundleRepositories(plans),
      ).resolves.toBeUndefined();
      expect(
        readFileSync(join(
          plans[0].finalDir,
          'checkpoints',
          'sandbox',
          'workdir.tar',
        ), 'utf8'),
      ).toBe('legacy-workdir');

      const company = new CompanySessionRepository({
        sessionRoot: plans[0].finalDir,
      });
      expect((await company.list('boardItem')).items).toMatchObject([
        {
          data: {
            title: 'Ship the cutover',
            status: 'doing',
          },
        },
      ]);

      const sprite = new SpriteSessionRepository({
        sessionRoot: plans[1].finalDir,
      });
      expect(await sprite.getProject(spriteUuid)).toMatchObject({
        data: {
          name: 'Fixture Sprite',
          status: 'active',
          exportDir: 'assets/sprites',
        },
      });
      expect((await sprite.list('asset')).items).toMatchObject([
        {
          data: {
            name: 'Hero',
            status: 'ready',
            product: {
              path: '.sprite-studio/hero.png',
            },
          },
        },
      ]);
    } finally {
      db.close();
    }
  });
});
