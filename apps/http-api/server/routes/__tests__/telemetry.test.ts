import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { getSessionTelemetrySummary } from '@mcp/code-agent/sessions/store/telemetry-session.js';
import { mountTelemetryRoutes } from '../telemetry.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      compaction_count_auto INTEGER NOT NULL DEFAULT 0,
      compaction_count_manual INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE coder_turn_telemetry (
      id INTEGER PRIMARY KEY,
      session_id INTEGER,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      provider TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      thinking_tokens INTEGER,
      history_chars INTEGER,
      tool_count INTEGER NOT NULL DEFAULT 0,
      tools_called_json TEXT,
      largest_tool_result_chars INTEGER,
      compaction_triggered INTEGER NOT NULL DEFAULT 0,
      summarizer_ran INTEGER NOT NULL DEFAULT 0,
      paginate_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      estimated_cost_usd REAL,
      system_prompt_chars INTEGER,
      tools_def_chars INTEGER
    );
    CREATE TABLE coder_tool_calls (
      id INTEGER PRIMARY KEY,
      message_id INTEGER NOT NULL,
      tool_use_id TEXT,
      tool_name TEXT NOT NULL,
      output_chars INTEGER,
      output_chars_shaped INTEGER,
      duration_ms INTEGER,
      truncated INTEGER NOT NULL DEFAULT 0,
      phase TEXT,
      parent_tool_use_id TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      refusal_kind TEXT,
      guard_action TEXT,
      guard_origin_tool_use_id TEXT,
      would_block INTEGER
    );
    INSERT INTO coder_sessions (id, compaction_count_auto)
    VALUES (1221, 5);
  `);
});

afterEach(() => db?.close());

describe('GET /api/sessions/:id/telemetry', () => {
  it('returns 200 for a pre-repair database missing eligible_tools_def_chars', async () => {
    const sessionStore = {
      getSessionTelemetrySummary: (id: number) => getSessionTelemetrySummary(db, id),
      getFirstTurnPayloadBreakdown: () => ({
        system_prompt_chars: null,
        tools_array_chars: null,
        tools_count: null,
        first_turn_input_tokens: null,
        first_turn_output_tokens: null,
        estimated_chars_per_token: 4,
        skills_mode: null,
        skills_count: null,
      }),
      getTurnTelemetry: () => [],
      listProviderAttempts: () => [],
    };
    const app = new Hono();
    mountTelemetryRoutes(app, { sessionStore, providerStore: {} } as unknown as ServerDeps);

    const response = await app.request('/api/sessions/1221/telemetry');
    const payload = await response.json() as {
      turn_count: number;
      compaction_count_auto: number;
      turns: unknown[];
      attempts: unknown[];
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      turn_count: 0,
      compaction_count_auto: 5,
      turns: [],
      attempts: [],
    });
  });
});
