import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';

/**
 * Per-turn telemetry — migration 069.
 * Verifies the SessionStore wrapper writes rows the dashboard can later query.
 */

describe('coder_turn_telemetry — SessionStore.recordTurnTelemetry', () => {
  let workDir: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let projectId: number;
  let sessionId: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'turn-tel-'));
    const dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    projectId = db.createProject('tel-proj', workDir).id;
  });

  afterAll(() => {
    store.close();
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sessionId = store.createSession({
      project_id: projectId,
      title: 't',
      provider: 'anthropic',
      model: 'sonnet',
    }).id;
  });

  it('persists a row with all the basic fields', () => {
    store.recordTurnTelemetry({
      session_id: sessionId,
      run_id: 'run-1',
      turn: 1,
      is_subagent: false,
      provider: 'anthropic',
      model: 'sonnet',
      input_tokens: 1234,
      output_tokens: 56,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 100,
      thinking_tokens: 0,
      history_chars: 5000,
      tool_count: 2,
      tools_called: ['read_file', 'edit_file'],
      largest_tool_result_chars: 9000,
      compaction_triggered: false,
      summarizer_ran: false,
      paginate_count: 0,
      response_meta: {
        path: '/v1/messages?beta=true',
        request: {
          api_model: 'claude-sonnet-4-6-20260320',
          requested_model: 'default',
          display_model: 'Sonnet 4.6',
          max_tokens: 64000,
          stream: true,
          betas: ['oauth-2025-04-20'],
          thinking_type: 'enabled',
          effort: 'high',
        },
        response: {
          status: 200,
          ok: true,
          request_id: 'req_test',
          retry_after: null,
          x_should_retry: null,
          rate_limits: {
            'anthropic-ratelimit-unified-status': 'allowed',
          },
        },
      },
    });

    const rows = store.getTurnTelemetry(sessionId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.run_id).toBe('run-1');
    expect(row.turn).toBe(1);
    expect(row.input_tokens).toBe(1234);
    expect(row.cache_read_input_tokens).toBe(1000);
    expect(row.tool_count).toBe(2);
    expect(JSON.parse(String(row.tools_called_json))).toEqual(['read_file', 'edit_file']);
    expect(row.largest_tool_result_chars).toBe(9000);
    expect(row.is_subagent).toBe(0);
    expect(row.compaction_triggered).toBe(0);
    expect(row.request_api_model).toBe('claude-sonnet-4-6-20260320');
    expect(row.request_requested_model).toBe('default');
    expect(row.request_display_model).toBe('Sonnet 4.6');
    expect(row.request_max_tokens).toBe(64000);
    expect(row.request_stream).toBe(1);
    expect(JSON.parse(String(row.request_betas_json))).toEqual(['oauth-2025-04-20']);
    expect(row.request_thinking_type).toBe('enabled');
    expect(row.request_effort).toBe('high');
    expect(row.response_status).toBe(200);
    expect(row.response_ok).toBe(1);
    expect(row.response_request_id).toBe('req_test');
    expect(row.response_path).toBe('/v1/messages?beta=true');
    expect(JSON.parse(String(row.response_rate_limits_json))).toEqual({
      'anthropic-ratelimit-unified-status': 'allowed',
    });
  });

  it('preserves turn ordering and tags subagent rows', () => {
    store.recordTurnTelemetry({
      session_id: sessionId, run_id: 'r', turn: 2, is_subagent: true,
      provider: 'a', model: 'm', input_tokens: 1, output_tokens: 1,
      cache_read_input_tokens: null, cache_creation_input_tokens: null, thinking_tokens: null,
      history_chars: 0, tool_count: 0, tools_called: [],
      largest_tool_result_chars: null, compaction_triggered: false,
      summarizer_ran: false, paginate_count: 0,
    });
    store.recordTurnTelemetry({
      session_id: sessionId, run_id: 'r', turn: 1, is_subagent: false,
      provider: 'a', model: 'm', input_tokens: 1, output_tokens: 1,
      cache_read_input_tokens: null, cache_creation_input_tokens: null, thinking_tokens: null,
      history_chars: 0, tool_count: 0, tools_called: [],
      largest_tool_result_chars: null, compaction_triggered: false,
      summarizer_ran: false, paginate_count: 0,
    });
    const rows = store.getTurnTelemetry(sessionId);
    expect(rows.map((r) => r.turn)).toEqual([1, 2]);
    expect(rows[1].is_subagent).toBe(1);
  });

  it('records compaction + pagination signals correctly', () => {
    store.recordTurnTelemetry({
      session_id: sessionId, run_id: 'r', turn: 1, is_subagent: false,
      provider: 'a', model: 'm', input_tokens: 100000, output_tokens: 200,
      cache_read_input_tokens: 80000, cache_creation_input_tokens: 0, thinking_tokens: 0,
      history_chars: 400000, tool_count: 3,
      tools_called: ['read_file', 'read_file', 'mcp__read_file'],
      largest_tool_result_chars: 24000,
      compaction_triggered: true, summarizer_ran: true, paginate_count: 2,
    });
    const row = store.getTurnTelemetry(sessionId)[0];
    expect(row.compaction_triggered).toBe(1);
    expect(row.summarizer_ran).toBe(1);
    expect(row.paginate_count).toBe(2);
  });

  it('does not throw on a row with all-null optional fields', () => {
    expect(() =>
      store.recordTurnTelemetry({
        session_id: null, run_id: 'orphan', turn: 1, is_subagent: false,
        provider: null, model: null, input_tokens: null, output_tokens: null,
        cache_read_input_tokens: null, cache_creation_input_tokens: null,
        thinking_tokens: null, history_chars: null, tool_count: 0, tools_called: [],
        largest_tool_result_chars: null, compaction_triggered: false,
        summarizer_ran: false, paginate_count: 0,
      }),
    ).not.toThrow();
  });
});

describe('SessionStore — telemetry aggregations (modal + dashboard)', () => {
  let workDir: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let projectId: number;
  let sessionA: number;
  let sessionB: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'turn-tel-agg-'));
    const dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    projectId = db.createProject('agg-proj', workDir).id;

    sessionA = store.createSession({
      project_id: projectId, title: 'big', provider: 'anthropic', model: 'sonnet',
    }).id;
    sessionB = store.createSession({
      project_id: projectId, title: 'small', provider: 'openai', model: 'gpt-4o',
    }).id;

    // Session A: 3 turns, lots of tokens, one paginated read
    store.recordTurnTelemetry({
      session_id: sessionA, run_id: 'r1', turn: 1, is_subagent: false,
      provider: 'anthropic', model: 'sonnet',
      input_tokens: 10_000, output_tokens: 200,
      cache_read_input_tokens: 6_000, cache_creation_input_tokens: 4_000, thinking_tokens: 0,
      history_chars: 40_000, tool_count: 2, tools_called: ['read_file', 'grep_code'],
      largest_tool_result_chars: 12_000, compaction_triggered: false,
      summarizer_ran: false, paginate_count: 0,
    });
    store.recordTurnTelemetry({
      session_id: sessionA, run_id: 'r1', turn: 2, is_subagent: false,
      provider: 'anthropic', model: 'sonnet',
      input_tokens: 12_000, output_tokens: 300,
      cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, thinking_tokens: 0,
      history_chars: 50_000, tool_count: 2, tools_called: ['read_file', 'read_file'],
      largest_tool_result_chars: 8_000, compaction_triggered: false,
      summarizer_ran: false, paginate_count: 1,
    });
    store.recordTurnTelemetry({
      session_id: sessionA, run_id: 'r1', turn: 3, is_subagent: true,
      provider: 'anthropic', model: 'sonnet',
      input_tokens: 5_000, output_tokens: 100,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0,
      history_chars: 5_000, tool_count: 1, tools_called: ['mcp__grep_code'],
      largest_tool_result_chars: 1_000, compaction_triggered: true,
      summarizer_ran: true, paginate_count: 0,
    });

    // Session B: 1 turn, small
    store.recordTurnTelemetry({
      session_id: sessionB, run_id: 'r2', turn: 1, is_subagent: false,
      provider: 'openai', model: 'gpt-4o',
      input_tokens: 1_000, output_tokens: 50,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0,
      history_chars: 2_000, tool_count: 0, tools_called: [],
      largest_tool_result_chars: null, compaction_triggered: false,
      summarizer_ran: false, paginate_count: 0,
    });
  });

  afterAll(() => {
    store.close();
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('getSessionTelemetrySummary aggregates across all turns of one session', () => {
    const s = store.getSessionTelemetrySummary(sessionA);
    expect(s.turn_count).toBe(3);
    expect(s.subagent_turn_count).toBe(1);
    expect(s.total_input_tokens).toBe(27_000);
    expect(s.total_output_tokens).toBe(600);
    expect(s.total_cache_read_tokens).toBe(15_000);
    expect(s.cache_hit_ratio).toBeCloseTo(15_000 / 27_000, 3);
    expect(s.total_tool_calls).toBe(5);
    expect(s.compaction_turns).toBe(1);
    expect(s.summarizer_turns).toBe(1);
    expect(s.paginate_total).toBe(1);
    expect(s.largest_tool_result_chars).toBe(12_000);
  });

  it('getSessionTelemetrySummary breaks tools down by call count', () => {
    const s = store.getSessionTelemetrySummary(sessionA);
    const readFile = s.tools_breakdown.find((b) => b.name === 'read_file');
    expect(readFile?.calls).toBe(3); // 1 in turn 1, 2 in turn 2
    expect(s.tools_breakdown[0].name).toBe('read_file'); // sorted desc
  });

  it('getSessionTelemetrySummary returns zeros for a session with no telemetry', () => {
    const empty = store.createSession({
      project_id: projectId, title: 'empty', provider: 'a', model: 'm',
    }).id;
    const s = store.getSessionTelemetrySummary(empty);
    expect(s.turn_count).toBe(0);
    expect(s.total_input_tokens).toBe(0);
    expect(s.cache_hit_ratio).toBe(null);
    expect(s.tools_breakdown).toEqual([]);
    // Migration 130 fields default to 0 on a fresh session.
    expect(s.messages_all).toBe(0);
    expect(s.messages_conversation).toBe(0);
    expect(s.messages_user).toBe(0);
    expect(s.compaction_count_auto).toBe(0);
    expect(s.compaction_count_manual).toBe(0);
  });

  it('counts lifetime messages by role and keeps them independent of the summary boundary (mig 130)', () => {
    const s = store.createSession({
      project_id: projectId, title: 'msgs', provider: 'a', model: 'm',
    }).id;
    store.appendMessage(s, { role: 'user', content: [{ type: 'text', text: 'q1' }] });
    store.appendMessage(s, { role: 'assistant', content: [{ type: 'text', text: 'a1' }] });
    store.appendMessage(s, { role: 'tool', content: [{ type: 'text', text: 'result' }] });
    store.appendMessage(s, { role: 'user', content: [{ type: 'text', text: 'q2' }] });

    const before = store.getSessionTelemetrySummary(s);
    expect(before.messages_all).toBe(4);          // user + assistant + tool + user
    expect(before.messages_conversation).toBe(3); // excludes the tool row
    expect(before.messages_user).toBe(2);

    // The whole point: summarizing the window must NOT shrink the lifetime
    // counts (rows are hidden, never deleted), but it DOES bump the manual
    // summarization counter.
    store.setCompactionBoundary(s, 'SUMMARY', store.maxMessageId(s), 'manual');
    const after = store.getSessionTelemetrySummary(s);
    expect(after.messages_all).toBe(4);
    expect(after.messages_conversation).toBe(3);
    expect(after.messages_user).toBe(2);
    expect(after.compaction_count_manual).toBe(1);
    expect(after.compaction_count_auto).toBe(0);
  });

  it('getGlobalTelemetrySummary aggregates across sessions and breaks down by provider/model', () => {
    const g = store.getGlobalTelemetrySummary({ limit: 10 });
    expect(g.overall.session_count).toBeGreaterThanOrEqual(2);
    expect(g.overall.turn_count).toBeGreaterThanOrEqual(4);
    expect(g.overall.total_input_tokens).toBe(28_000);

    const anthropic = g.by_provider.find((r) => r.provider === 'anthropic');
    expect(anthropic?.input_tokens).toBe(27_000);
    const openai = g.by_provider.find((r) => r.provider === 'openai');
    expect(openai?.input_tokens).toBe(1_000);
    // by_provider sorted by input_tokens desc
    expect(g.by_provider[0].provider).toBe('anthropic');
  });

  it('top_sessions ranks sessions by total input tokens with title/provider joined', () => {
    const g = store.getGlobalTelemetrySummary({ limit: 10 });
    expect(g.top_sessions[0].title).toBe('big');
    expect(g.top_sessions[0].total_input_tokens).toBe(27_000);
    expect(g.top_sessions[0].provider).toBe('anthropic');
    expect(g.top_sessions[0].model).toBe('sonnet');
  });
});
